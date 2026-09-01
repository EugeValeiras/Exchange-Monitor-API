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
import { formatAlertPrice } from './alert-assets';

@Injectable()
export class ThresholdAlertService implements OnModuleInit {
  private readonly logger = new Logger(ThresholdAlertService.name);

  // Percentage change required to trigger alert (1% = 0.01)
  private readonly alertPercentage = 0.01;

  /// Activos que le interesan a alguien, cacheados. `handlePriceUpdate` corre
  /// en cada tick de cada exchange: sin este corte iríamos a la base miles de
  /// veces por minuto para descubrir que a nadie le importa el activo.
  private interestedAssets: Set<string> | null = null;
  private interestedAssetsExpiry = 0;
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
    this.interestedAssets = null;
    this.interestedAssetsExpiry = 0;
  }

  private async getInterestedAssets(): Promise<Set<string>> {
    const now = Date.now();
    if (this.interestedAssets && now < this.interestedAssetsExpiry) {
      return this.interestedAssets;
    }

    try {
      this.interestedAssets =
        await this.notificationsService.getAssetsWithInterest();
      this.interestedAssetsExpiry =
        now + ThresholdAlertService.INTEREST_TTL_MS;
    } catch (error) {
      // Si la base falla, no callamos las alertas para siempre: se reintenta
      // en el próximo tick con lo último que supimos.
      this.logger.error(`Failed to load alert assets: ${error.message}`);
      this.interestedAssets = this.interestedAssets ?? new Set<string>();
    }

    return this.interestedAssets;
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
    const [rawAsset, rawQuote] = symbol.split('/');
    const baseAsset = rawAsset.toUpperCase();
    const quote = (rawQuote ?? '').toUpperCase();
    const currentPrice = priceData.price;

    // ¿Le interesa a alguien? Antes esto era una tabla de cinco activos
    // escrita a mano; ahora sale de lo que cada uno eligió seguir.
    const interested = await this.getInterestedAssets();
    if (!interested.has(baseAsset)) {
      return;
    }

    // Sólo pares contra dólar: el formato de la alerta lleva "$".
    if (!ThresholdAlertService.DOLLAR_QUOTES.has(quote)) {
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
        `Initialized price tracking for ${symbol}: ${formatAlertPrice(currentPrice)}`,
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
        `Price alert for ${baseAsset}: ${formatAlertPrice(lastNotifiedPrice)} -> ${formatAlertPrice(currentPrice)} (${direction} ${changePercent}%)`,
      );

      // Send alert to all users with push tokens
      await this.sendPriceAlert(
        baseAsset,
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
    asset: string,
    currentPrice: number,
    lastPrice: number,
    direction: 'up' | 'down',
    percentageChange: number,
  ): Promise<void> {
    const arrow = direction === 'up' ? '↑' : '↓';
    const emoji = direction === 'up' ? '📈' : '📉';
    const changePercent = (percentageChange * 100).toFixed(1);
    const sign = direction === 'up' ? '+' : '-';

    const title = `${emoji} ${asset} ${arrow} ${formatAlertPrice(currentPrice)}`;
    const body = `${asset} ${sign}${changePercent}% (${formatAlertPrice(lastPrice)} → ${formatAlertPrice(currentPrice)})`;

    // Sólo a quienes este movimiento les corresponde: siguen este activo, su
    // umbral lo cubre y no están en su franja de silencio.
    const allTokens = await this.notificationsService.getTokensForPriceChange(
      percentageChange * 100,
      asset,
    );

    if (allTokens.length === 0) {
      this.logger.debug(
        'No tokens with notifications enabled, skipping alert',
      );
      return;
    }

    this.logger.log(
      `Sending price alert for ${asset} to ${allTokens.length} tokens`,
    );

    const result = await this.firebaseService.sendMulticastNotification(
      allTokens,
      title,
      body,
      {
        type: 'price_alert',
        asset,
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
