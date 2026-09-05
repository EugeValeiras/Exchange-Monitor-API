import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger, Optional, Inject, forwardRef } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ConnectionStatus, PriceAggregatorService } from './price-aggregator.service';
import { AggregatedPrice } from './exchange-stream.interface';
import { SettingsService } from '../../settings/settings.service';
import { BinanceDepthStreamService, DepthUpdate } from './binance-depth-stream.service';
import { BinanceKlineStreamService, KlineUpdate } from './binance-kline-stream.service';

@WebSocketGateway({
  cors: {
    origin: true,
    credentials: true,
  },
  namespace: '/prices',
})
export class PricesGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(PricesGateway.name);

  @WebSocketServer()
  server: Server;

  private configuredSymbols: Set<string> = new Set();
  private configuredByBase: Map<string, string[]> = new Map();
  private configuredToRequested: Map<string, Set<string>> = new Map();

  /** Qué velas mira cada cliente, para soltarlas cuando se desconecta. */
  private readonly klineViewers = new Map<string, Set<string>>();

  /** Qué libros mira cada cliente, para soltarlos cuando se desconecta. */
  private readonly orderbookViewers = new Map<string, Set<string>>();
  /** Última emisión por libro: Binance manda diez por segundo, se pasan cuatro. */
  private readonly orderbookLastSent = new Map<string, number>();
  private readonly orderbookPending = new Map<string, NodeJS.Timeout>();
  private static readonly ORDERBOOK_MIN_INTERVAL_MS = 250;

  constructor(
    private readonly priceAggregator: PriceAggregatorService,
    private readonly depthStream: BinanceDepthStreamService,
    private readonly klineStream: BinanceKlineStreamService,
    @Optional() @Inject(forwardRef(() => SettingsService))
    private readonly settingsService?: SettingsService,
  ) {
    this.loadConfiguredSymbols();
  }

  private async loadConfiguredSymbols(): Promise<void> {
    if (!this.settingsService) return;

    try {
      const byExchange = await this.settingsService.getAllConfiguredSymbolsByExchange();
      const all = new Set<string>();
      for (const symbols of Object.values(byExchange)) {
        for (const s of symbols) all.add(s);
      }
      this.configuredSymbols = all;
      this.rebuildConfiguredByBase();
      this.pruneStaleMappings();
      this.logger.log(`Loaded ${this.configuredSymbols.size} configured symbols for gateway`);
    } catch (error) {
      this.logger.error(`Failed to load configured symbols: ${error.message}`);
    }
  }

  private rebuildConfiguredByBase(): void {
    this.configuredByBase = new Map();
    for (const symbol of this.configuredSymbols) {
      const base = symbol.split('/')[0];
      const existing = this.configuredByBase.get(base);
      if (existing) {
        existing.push(symbol);
      } else {
        this.configuredByBase.set(base, [symbol]);
      }
    }
  }

  private pruneStaleMappings(): void {
    for (const configured of this.configuredToRequested.keys()) {
      if (!this.configuredSymbols.has(configured)) {
        this.configuredToRequested.delete(configured);
      }
    }
  }

  private resolveRequestedSymbol(requested: string): string[] {
    if (this.configuredSymbols.has(requested)) {
      return [requested];
    }
    const base = requested.split('/')[0];
    return this.configuredByBase.get(base) ?? [];
  }

  @OnEvent('settings.symbols.updated')
  async handleSymbolsUpdated(): Promise<void> {
    await this.loadConfiguredSymbols();
  }

  @OnEvent('prices.subscriptions.updated')
  broadcastConnectionStatus(status: ConnectionStatus): void {
    this.server.emit('connection:status', status);
  }

  afterInit(): void {
    this.logger.log('Prices WebSocket Gateway initialized');
    // Acá y no en el constructor: sólo la instancia que Nest cablea al
    // servidor pasa por afterInit. Registrarlo antes dejaba el callback en una
    // instancia con `server` en null, y el relay reventaba.
    this.depthStream.onUpdate((book) => this.relayOrderbook(book));
    this.klineStream.onUpdate((k) => this.relayKline(k));
  }

  handleConnection(client: Socket): void {
    this.logger.log(`Client connected: ${client.id}`);

    // Send current prices on connect
    const currentPrices = this.priceAggregator.getAllPrices();
    client.emit('prices:initial', currentPrices);

    // Send connection status
    client.emit('connection:status', this.priceAggregator.getConnectionStatus());
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`Client disconnected: ${client.id}`);
    for (const key of this.orderbookViewers.get(client.id) ?? []) {
      this.releaseOrderbook(client, key);
    }
    this.orderbookViewers.delete(client.id);

    for (const key of this.klineViewers.get(client.id) ?? []) {
      this.releaseKline(client, key);
    }
    this.klineViewers.delete(client.id);
  }

  // ==================== VELAS EN VIVO ====================

  /**
   * Un cliente mira un par en un intervalo. Sólo Binance emite velas; al resto
   * se le avisa y sigue repidiendo por REST.
   */
  @SubscribeMessage('kline:subscribe')
  handleKlineSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { exchange?: string; symbol?: string; timeframe?: string },
  ): void {
    const exchange = (body?.exchange ?? '').toLowerCase();
    const symbol = (body?.symbol ?? '').toUpperCase();
    const timeframe = (body?.timeframe ?? '').toLowerCase();
    if (!symbol || !timeframe) return;

    if (exchange !== 'binance' || !this.klineStream.soporta(timeframe)) {
      client.emit('kline:unsupported', { exchange, symbol, timeframe });
      return;
    }

    const key = `${exchange}:${symbol}:${timeframe}`;
    const mine = this.klineViewers.get(client.id) ?? new Set<string>();
    if (mine.has(key)) return;
    mine.add(key);
    this.klineViewers.set(client.id, mine);

    client.join(`kline:${key}`);
    this.klineStream.subscribe(symbol, timeframe);
    this.logger.log(`Client ${client.id} mira las velas de ${key}`);
  }

  @SubscribeMessage('kline:unsubscribe')
  handleKlineUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { exchange?: string; symbol?: string; timeframe?: string },
  ): void {
    const key = `${(body?.exchange ?? '').toLowerCase()}:${(body?.symbol ?? '').toUpperCase()}:${(body?.timeframe ?? '').toLowerCase()}`;
    const mine = this.klineViewers.get(client.id);
    if (!mine?.has(key)) return;
    mine.delete(key);
    this.releaseKline(client, key);
  }

  private releaseKline(client: Socket, key: string): void {
    client.leave(`kline:${key}`);
    const [exchange, symbol, timeframe] = key.split(':');
    if (exchange === 'binance') this.klineStream.unsubscribe(symbol, timeframe);
  }

  /**
   * Reenvía la vela a su sala. No hace falta estrangular: Binance manda un par
   * por segundo por stream, no diez como la profundidad.
   */
  private relayKline(k: KlineUpdate): void {
    try {
      if (!this.server) return;
      this.server
        .to(`kline:${k.exchange}:${k.symbol.toUpperCase()}:${k.timeframe}`)
        .emit('kline:update', k);
    } catch (error) {
      this.logger.error(`No pude reenviar la vela: ${(error as Error).message}`);
    }
  }

  // ==================== LIBRO DE ÓRDENES EN VIVO ====================

  /**
   * Un cliente quiere ver la profundidad de un par. Sólo Binance la emite por
   * WebSocket; para el resto se le avisa y el cliente sigue por REST.
   */
  @SubscribeMessage('orderbook:subscribe')
  handleOrderbookSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { exchange?: string; symbol?: string },
  ): void {
    const exchange = (body?.exchange ?? '').toLowerCase();
    const symbol = (body?.symbol ?? '').toUpperCase();
    if (!symbol) return;

    if (exchange !== 'binance') {
      client.emit('orderbook:unsupported', {
        exchange,
        symbol,
        reason: `${exchange} no emite profundidad en vivo; se sigue por REST`,
      });
      return;
    }

    const key = `${exchange}:${symbol}`;
    const mine = this.orderbookViewers.get(client.id) ?? new Set<string>();
    if (mine.has(key)) return;
    mine.add(key);
    this.orderbookViewers.set(client.id, mine);

    client.join(`orderbook:${key}`);
    this.depthStream.subscribe(symbol);
    this.logger.log(`Client ${client.id} mira el libro de ${key}`);
  }

  @SubscribeMessage('orderbook:unsubscribe')
  handleOrderbookUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { exchange?: string; symbol?: string },
  ): void {
    const key = `${(body?.exchange ?? '').toLowerCase()}:${(body?.symbol ?? '').toUpperCase()}`;
    const mine = this.orderbookViewers.get(client.id);
    if (!mine?.has(key)) return;
    mine.delete(key);
    this.releaseOrderbook(client, key);
  }

  private releaseOrderbook(client: Socket, key: string): void {
    client.leave(`orderbook:${key}`);
    const [exchange, symbol] = key.split(':');
    if (exchange === 'binance') this.depthStream.unsubscribe(symbol);
  }

  /** Reenvía un libro a su sala, a lo sumo cuatro veces por segundo. */
  private relayOrderbook(book: DepthUpdate): void {
    const key = `${book.exchange}:${book.symbol}`;
    const now = Date.now();
    const last = this.orderbookLastSent.get(key) ?? 0;
    const wait = PricesGateway.ORDERBOOK_MIN_INTERVAL_MS - (now - last);

    const emit = () => {
      this.orderbookLastSent.set(key, Date.now());
      this.orderbookPending.delete(key);
      // Corre en un timer: una excepción acá no tiene quién la atrape y
      // mataría el proceso entero. Nunca.
      try {
        if (!this.server) return;
        this.server.to(`orderbook:${key}`).emit('orderbook:update', {
        exchange: book.exchange,
        symbol: book.symbol,
        timestamp: book.timestamp.toISOString(),
        datetime: book.timestamp.toISOString(),
        nonce: null,
        bids: book.bids,
        asks: book.asks,
        source: 'stream',
      });
      } catch (error) {
        this.logger.error(`No pude reenviar el libro de ${key}: ${(error as Error).message}`);
      }
    };

    if (wait <= 0) {
      emit();
      return;
    }
    // Ya hay uno programado: el más nuevo reemplaza al anterior, no se suma.
    const pending = this.orderbookPending.get(key);
    if (pending) clearTimeout(pending);
    this.orderbookPending.set(key, setTimeout(emit, wait));
  }

  @SubscribeMessage('subscribe')
  handleSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() symbols: string[],
  ): void {
    this.logger.log(`Client ${client.id} subscribing to: ${symbols.join(', ')}`);

    // Resolve each requested symbol to the configured symbols that share its base asset.
    // This lets clients request MON/USDT and receive updates from a configured MON/USDT:USDT perp feed.
    const toAggregator = new Set<string>();
    const unresolved: string[] = [];
    const noConfig = this.configuredSymbols.size === 0;

    for (const requested of symbols) {
      client.join(`price:${requested}`);

      if (noConfig) {
        toAggregator.add(requested);
        continue;
      }

      const resolved = this.resolveRequestedSymbol(requested);
      if (resolved.length === 0) {
        unresolved.push(requested);
        continue;
      }

      for (const configured of resolved) {
        toAggregator.add(configured);
        if (configured !== requested) {
          let set = this.configuredToRequested.get(configured);
          if (!set) {
            set = new Set();
            this.configuredToRequested.set(configured, set);
          }
          set.add(requested);
        }
      }
    }

    if (unresolved.length > 0) {
      this.logger.debug(`Skipping unconfigured symbols: ${unresolved.join(', ')}`);
    }

    if (toAggregator.size > 0) {
      this.priceAggregator.subscribeToSymbols(Array.from(toAggregator));
    }

    // Send current prices for requested symbols, re-labeled from mapped configured feeds if needed
    for (const requested of symbols) {
      const direct = this.priceAggregator.getLatestPrice(requested);
      if (direct) {
        client.emit('price:update', direct);
        continue;
      }
      if (noConfig) continue;
      const resolved = this.resolveRequestedSymbol(requested);
      for (const configured of resolved) {
        const latest = this.priceAggregator.getLatestPrice(configured);
        if (latest) {
          client.emit('price:update', { ...latest, symbol: requested });
          break;
        }
      }
    }
  }

  @SubscribeMessage('unsubscribe')
  handleUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() symbols: string[],
  ): void {
    this.logger.log(
      `Client ${client.id} unsubscribing from: ${symbols.join(', ')}`,
    );

    symbols.forEach((symbol) => {
      client.leave(`price:${symbol}`);
    });
  }

  @SubscribeMessage('ping')
  handlePing(@ConnectedSocket() client: Socket): void {
    client.emit('pong', { timestamp: Date.now() });
  }

  @OnEvent('price.update')
  handlePriceUpdate(price: AggregatedPrice): void {
    // Broadcast to room for this specific symbol
    this.server.to(`price:${price.symbol}`).emit('price:update', price);

    // Re-emit to requested-symbol rooms that were resolved to this configured symbol,
    // rewriting the label so clients receive the pair they asked for.
    const requestedLabels = this.configuredToRequested.get(price.symbol);
    if (requestedLabels) {
      for (const requested of requestedLabels) {
        this.server
          .to(`price:${requested}`)
          .emit('price:update', { ...price, symbol: requested });
      }
    }

    // Also broadcast to general channel for dashboard updates
    this.server.emit('price:tick', {
      symbol: price.symbol,
      price: price.price,
      timestamp: price.timestamp,
    });
  }
}
