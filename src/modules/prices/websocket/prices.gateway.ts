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
import { PriceAggregatorService } from './price-aggregator.service';
import { AggregatedPrice } from './exchange-stream.interface';
import { SettingsService } from '../../settings/settings.service';

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

  constructor(
    private readonly priceAggregator: PriceAggregatorService,
    @Optional() @Inject(forwardRef(() => SettingsService))
    private readonly settingsService?: SettingsService,
  ) {
    this.loadConfiguredSymbols();
  }

  private async loadConfiguredSymbols(): Promise<void> {
    if (!this.settingsService) return;

    try {
      this.configuredSymbols = await this.settingsService.getConfiguredSymbolsSet();
      this.logger.log(`Loaded ${this.configuredSymbols.size} configured symbols for gateway`);
    } catch (error) {
      this.logger.error(`Failed to load configured symbols: ${error.message}`);
    }
  }

  @OnEvent('settings.symbols.updated')
  async handleSymbolsUpdated(): Promise<void> {
    await this.loadConfiguredSymbols();
  }

  afterInit(): void {
    this.logger.log('Prices WebSocket Gateway initialized');
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
  }

  @SubscribeMessage('subscribe')
  handleSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() symbols: string[],
  ): void {
    this.logger.log(`Client ${client.id} subscribing to: ${symbols.join(', ')}`);

    // Join room for each symbol (client can listen to any symbol)
    symbols.forEach((symbol) => {
      client.join(`price:${symbol}`);
    });

    // Only subscribe to symbols that are configured in global settings
    // This prevents dynamic subscription to unconfigured symbols
    const symbolsToSubscribe = this.configuredSymbols.size > 0
      ? symbols.filter((s) => this.configuredSymbols.has(s))
      : symbols; // If no configured symbols, allow all (fallback)

    if (symbolsToSubscribe.length > 0 && symbolsToSubscribe.length < symbols.length) {
      const skipped = symbols.filter((s) => !this.configuredSymbols.has(s));
      this.logger.debug(`Skipping unconfigured symbols: ${skipped.join(', ')}`);
    }

    if (symbolsToSubscribe.length > 0) {
      this.priceAggregator.subscribeToSymbols(symbolsToSubscribe);
    }

    // Send current prices for subscribed symbols
    symbols.forEach((symbol) => {
      const price = this.priceAggregator.getLatestPrice(symbol);
      if (price) {
        client.emit('price:update', price);
      }
    });
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

    // Also broadcast to general channel for dashboard updates
    this.server.emit('price:tick', {
      symbol: price.symbol,
      price: price.price,
      timestamp: price.timestamp,
    });
  }
}
