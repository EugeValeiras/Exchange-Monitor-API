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

interface AssetConfig {
  formatPrice: (price: number) => string;
}

@Injectable()
export class ThresholdAlertService implements OnModuleInit {
  private readonly logger = new Logger(ThresholdAlertService.name);

  // Percentage change required to trigger alert (1% = 0.01)
  private readonly alertPercentage = 0.01;

  // Assets to track with their price formatting
  private readonly trackedAssets: Map<string, AssetConfig> = new Map([
    ['BTC', { formatPrice: (p) => `$${p.toLocaleString('en-US', { maximumFractionDigits: 0 })}` }],
    ['ETH', { formatPrice: (p) => `$${p.toLocaleString('en-US', { maximumFractionDigits: 0 })}` }],
    ['NEXO', { formatPrice: (p) => `$${p.toFixed(2)}` }],
    ['MON', { formatPrice: (p) => `$${p.toFixed(4)}` }],
    ['SOL', { formatPrice: (p) => `$${p.toFixed(2)}` }],
  ]);

  // In-memory cache of last notified prices
  private lastNotifiedPrices = new Map<string, number>();

  constructor(
    @InjectModel(PriceThreshold.name)
    private priceThresholdModel: Model<PriceThresholdDocument>,
    private readonly firebaseService: FirebaseService,
    private readonly notificationsService: NotificationsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.loadLastPricesFromDb();
  }

  private async loadLastPricesFromDb(): Promise<void> {
    try {
      const records = await this.priceThresholdModel.find().exec();
      records.forEach((record) => {
        // Use lastPrice as the last notified price
        this.lastNotifiedPrices.set(record.asset, record.lastPrice);
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
    const baseAsset = symbol.split('/')[0].toUpperCase();
    const currentPrice = priceData.price;

    // Check if this asset is tracked
    const config = this.trackedAssets.get(baseAsset);
    if (!config) {
      return;
    }

    const lastNotifiedPrice = this.lastNotifiedPrices.get(baseAsset);

    // First time seeing this asset, initialize with current price
    if (lastNotifiedPrice === undefined) {
      await this.updateLastNotifiedPrice(baseAsset, currentPrice);
      this.logger.log(
        `Initialized price tracking for ${baseAsset}: ${config.formatPrice(currentPrice)}`,
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
        `Price alert for ${baseAsset}: ${config.formatPrice(lastNotifiedPrice)} -> ${config.formatPrice(currentPrice)} (${direction} ${changePercent}%)`,
      );

      // Send alert to all users with push tokens
      await this.sendPriceAlert(
        baseAsset,
        currentPrice,
        lastNotifiedPrice,
        direction,
        percentageChange,
        config,
      );

      // Update last notified price
      await this.updateLastNotifiedPrice(baseAsset, currentPrice);
    }
  }

  private async updateLastNotifiedPrice(
    asset: string,
    price: number,
  ): Promise<void> {
    try {
      await this.priceThresholdModel.findOneAndUpdate(
        { asset },
        {
          asset,
          lastThresholdLevel: price, // Keeping field name for backwards compatibility
          lastPrice: price,
          timestamp: new Date(),
        },
        { upsert: true },
      );
      this.lastNotifiedPrices.set(asset, price);
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
    config: AssetConfig,
  ): Promise<void> {
    const arrow = direction === 'up' ? '↑' : '↓';
    const emoji = direction === 'up' ? '📈' : '📉';
    const changePercent = (percentageChange * 100).toFixed(1);
    const sign = direction === 'up' ? '+' : '-';

    const title = `${emoji} ${asset} ${arrow} ${config.formatPrice(currentPrice)}`;
    const body = `${asset} ${sign}${changePercent}% (${config.formatPrice(lastPrice)} → ${config.formatPrice(currentPrice)})`;

    // Get all users with push tokens
    const allTokens = await this.notificationsService.getAllUserTokens();

    if (allTokens.length === 0) {
      this.logger.debug('No push tokens registered, skipping alert');
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
