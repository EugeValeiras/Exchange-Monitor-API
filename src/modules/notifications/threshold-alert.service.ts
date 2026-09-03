import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { OnEvent } from '@nestjs/event-emitter';
import { FirebaseService } from './firebase.service';
import { NotificationsService } from './notifications.service';
import {
  PriceThreshold,
  PriceThresholdDocument,
} from './schemas/price-threshold.schema';
import { AggregatedPrice } from '../prices/websocket/exchange-stream.interface';
import { formatAlertPrice, splitSymbol } from './alert-assets';

@Injectable()
export class ThresholdAlertService implements OnModuleInit {
  private readonly logger = new Logger(ThresholdAlertService.name);

  // Percentage change required to trigger alert (1% = 0.01)
  private readonly alertPercentage = 0.01;

  /// Pares que le interesan a alguien, cacheados. `handlePriceUpdate` corre
  /// en cada tick de cada exchange: sin este corte iríamos a la base miles de
  /// veces por minuto para descubrir que a nadie le importa el par.
  private interestedSymbols: Set<string> | null = null;

  /// Todos los pares que vimos pasar. Hace falta para traducir la preferencia
  /// vieja —elegida por activo— a la lista de pares que existen hoy.
  private readonly knownSymbols = new Set<string>();
  private interestedSymbolsExpiry = 0;
  private static readonly INTEREST_TTL_MS = 60_000;

  /// Último precio notificado POR PAR. La clave es el símbolo entero
  /// (`NEXO/USDT`), no el activo: llevarlo por activo hacía que las
  /// cotizaciones de `NEXO/USDT` (0,83) y `NEXO/BTC` (0,0000106) se pisaran
  /// entre sí y cada update disparara una alerta de −100 % o +7.700.000 %,
  /// alternándose para siempre.
  private lastNotifiedPrices = new Map<string, number>();

  /// Monedas de cotización que se pueden mostrar con "$". Un par contra BTC
  /// necesita otro formato, así que por ahora no se notifica: mostrarlo como
  /// "$0.00" era decir cualquier cosa.
  private static readonly DOLLAR_QUOTES = new Set([
    'USD', 'USDT', 'USDC', 'BUSD', 'DAI', 'TUSD', 'USDP',
  ]);

  constructor(
    @InjectModel(PriceThreshold.name)
    private priceThresholdModel: Model<PriceThresholdDocument>,
    private readonly firebaseService: FirebaseService,
    private readonly notificationsService: NotificationsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.loadLastPricesFromDb();
  }

  /// Cambiar la selección tiene que sentirse al toque: sin esto habría que
  /// esperar a que venza el TTL para que el primer aviso nuevo llegue, y
  /// parecería que el interruptor no hizo nada.
  @OnEvent('notification.settings.updated')
  invalidateInterestCache(): void {
    this.interestedSymbols = null;
    this.interestedSymbolsExpiry = 0;
  }

  private async getInterestedSymbols(): Promise<Set<string>> {
    const now = Date.now();
    if (this.interestedSymbols && now < this.interestedSymbolsExpiry) {
      return this.interestedSymbols;
    }

    try {
      this.interestedSymbols =
        await this.notificationsService.getSymbolsWithInterest([
          ...this.knownSymbols,
        ]);
      this.interestedSymbolsExpiry =
        now + ThresholdAlertService.INTEREST_TTL_MS;
    } catch (error) {
      // Si la base falla, no callamos las alertas para siempre: se reintenta
      // en el próximo tick con lo último que supimos.
      this.logger.error(`Failed to load alert pairs: ${error.message}`);
      this.interestedSymbols = this.interestedSymbols ?? new Set<string>();
    }

    return this.interestedSymbols;
  }

  private async loadLastPricesFromDb(): Promise<void> {
    try {
      const records = await this.priceThresholdModel.find().exec();
      records.forEach((record) => {
        // Los registros viejos guardaban sólo el activo. Sin símbolo no se
        // pueden reusar sin volver a mezclar pares, así que se ignoran: el
        // primer update de cada par recrea su marca.
        if (record.symbol) {
          this.lastNotifiedPrices.set(record.symbol, record.lastPrice);
        }
      });
      this.logger.log(
        `Loaded ${records.length} last notified prices from database`,
      );
    } catch (error) {
      this.logger.error(`Failed to load prices: ${error.message}`);
    }
  }

  @OnEvent('price.update')
  async handlePriceUpdate(priceData: AggregatedPrice): Promise<void> {
    if (!this.firebaseService.isReady()) {
      return;
    }

    const symbol = priceData.symbol;
    const { base: baseAsset, quote } = splitSymbol(symbol);
    const currentPrice = priceData.price;

    // El catálogo de pares que existen, para poder traducir una preferencia
    // vieja elegida por activo.
    this.knownSymbols.add(symbol.toUpperCase());

    // ¿Le interesa a alguien? La unidad es el PAR: NEXO/USDT y NEXO/BTC no
    // son la misma cosa y ahora se pueden seguir por separado. El filtro de
    // "sólo contra dólar" que había acá era un parche para que NEXO/BTC no
    // llegara con formato de dólares; ahora el precio se escribe en su
    // moneda, así que el par puede elegirse como cualquier otro.
    const interested = await this.getInterestedSymbols();
    if (!interested.has(symbol.toUpperCase())) {
      return;
    }

    // Un precio en cero no es una cotización: dividir por él da infinito y es
    // lo que producía los porcentajes de siete cifras.
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
      return;
    }

    const lastNotifiedPrice = this.lastNotifiedPrices.get(symbol);

    // First time seeing this pair, initialize with current price
    if (lastNotifiedPrice === undefined || lastNotifiedPrice <= 0) {
      await this.updateLastNotifiedPrice(symbol, baseAsset, currentPrice);
      this.logger.log(
        `Initialized price tracking for ${symbol}: ${formatAlertPrice(currentPrice, quote)}`,
      );
      return;
    }

    // Calculate percentage change from last notified price
    const percentageChange = Math.abs(currentPrice - lastNotifiedPrice) / lastNotifiedPrice;

    // Check if change exceeds threshold
    if (percentageChange >= this.alertPercentage) {
      const direction = currentPrice > lastNotifiedPrice ? 'up' : 'down';
      const changePercent = (percentageChange * 100).toFixed(2);

      this.logger.log(
        `Price alert for ${symbol}: ${formatAlertPrice(lastNotifiedPrice, quote)} -> ${formatAlertPrice(currentPrice, quote)} (${direction} ${changePercent}%)`,
      );

      // Send alert to all users with push tokens
      await this.sendPriceAlert(
        symbol,
        currentPrice,
        lastNotifiedPrice,
        direction,
        percentageChange,
      );
      // Update last notified price
      await this.updateLastNotifiedPrice(symbol, baseAsset, currentPrice);
    }
  }

  private async updateLastNotifiedPrice(
    symbol: string,
    asset: string,
    price: number,
  ): Promise<void> {
    try {
      await this.priceThresholdModel.findOneAndUpdate(
        { symbol },
        {
          symbol,
          asset,
          lastThresholdLevel: price, // Keeping field name for backwards compatibility
          lastPrice: price,
          timestamp: new Date(),
        },
        { upsert: true },
      );
      this.lastNotifiedPrices.set(symbol, price);
    } catch (error) {
      this.logger.error(`Failed to update last notified price: ${error.message}`);
    }
  }

  private async sendPriceAlert(
    symbol: string,
    currentPrice: number,
    lastPrice: number,
    direction: 'up' | 'down',
    percentageChange: number,
  ): Promise<void> {
    const { base: asset, quote } = splitSymbol(symbol);
    const arrow = direction === 'up' ? '↑' : '↓';
    const emoji = direction === 'up' ? '📈' : '📉';
    const changePercent = (percentageChange * 100).toFixed(1);
    const sign = direction === 'up' ? '+' : '-';

    // El aviso nombra el PAR, no sólo el activo: "NEXO ↑" no alcanza cuando
    // podés estar siguiendo NEXO/USDT y NEXO/BTC a la vez, y el precio se
    // escribe en la moneda contra la que cotiza.
    const precio = formatAlertPrice(currentPrice, quote);
    const anterior = formatAlertPrice(lastPrice, quote);

    const title = `${emoji} ${symbol} ${arrow} ${precio}`;
    const body = `${symbol} ${sign}${changePercent}% (${anterior} → ${precio})`;

    // Sólo a quienes este movimiento les corresponde: siguen este par, su
    // umbral lo cubre y no están en su franja de silencio.
    const allTokens = await this.notificationsService.getTokensForPriceChange(
      percentageChange * 100,
      symbol,
    );

    if (allTokens.length === 0) {
      this.logger.debug(
        'No tokens with notifications enabled, skipping alert',
      );
      return;
    }

    this.logger.log(
      `Sending price alert for ${symbol} to ${allTokens.length} tokens`,
    );

    const result = await this.firebaseService.sendMulticastNotification(
      allTokens,
      title,
      body,
      {
        type: 'price_alert',
        asset,
        symbol,
        price: currentPrice.toString(),
        lastPrice: lastPrice.toString(),
        direction,
        percentageChange: percentageChange.toString(),
      },
    );

    this.logger.log(
      `Price alert sent: ${result.successCount}/${allTokens.length} successful`,
    );
  }
}
