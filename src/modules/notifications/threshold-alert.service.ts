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

interface ThresholdConfig {
  step: number; // The price step for alerts (e.g., 1000 for BTC, 0.01 for NEXO)
  formatPrice: (price: number) => string; // How to format the price in notifications
}

@Injectable()
export class ThresholdAlertService implements OnModuleInit {
  private readonly logger = new Logger(ThresholdAlertService.name);

  // Configuration for each asset
  private readonly thresholdConfigs: Map<string, ThresholdConfig> = new Map([
    [
      'BTC',
      {
        step: 1000,
        formatPrice: (p) => `$${p.toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
      },
    ],
    [
      'NEXO',
      {
        step: 0.01,
        formatPrice: (p) => `$${p.toFixed(2)}`,
      },
    ],
    [
      'MON',
      {
        step: 0.001,
        formatPrice: (p) => `$${p.toFixed(3)}`,
      },
    ],
  ]);

  // In-memory cache of last threshold levels
  private lastThresholds = new Map<string, number>();

  constructor(
    @InjectModel(PriceThreshold.name)
    private priceThresholdModel: Model<PriceThresholdDocument>,
    private readonly firebaseService: FirebaseService,
    private readonly notificationsService: NotificationsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.loadThresholdsFromDb();
  }

  private async loadThresholdsFromDb(): Promise<void> {
    try {
      const thresholds = await this.priceThresholdModel.find().exec();
      thresholds.forEach((threshold) => {
        this.lastThresholds.set(threshold.asset, threshold.lastThresholdLevel);
      });
      this.logger.log(
        `Loaded ${thresholds.length} price thresholds from database`,
      );
    } catch (error) {
      this.logger.error(`Failed to load thresholds: ${error.message}`);
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

    // Check if this asset has threshold config
    const config = this.thresholdConfigs.get(baseAsset);
    if (!config) {
      return; // Not a tracked asset
    }

    // Calculate current threshold level
    const currentThreshold = this.calculateThreshold(currentPrice, config.step);
    const lastThreshold = this.lastThresholds.get(baseAsset);

    // First time seeing this asset, just store the threshold
    if (lastThreshold === undefined) {
      await this.updateThreshold(baseAsset, currentThreshold, currentPrice);
      this.logger.log(
        `Initialized threshold for ${baseAsset}: ${config.formatPrice(currentThreshold)}`,
      );
      return;
    }

    // Check if threshold changed
    if (currentThreshold !== lastThreshold) {
      const direction = currentThreshold > lastThreshold ? 'up' : 'down';

      this.logger.log(
        `Threshold crossed for ${baseAsset}: ${config.formatPrice(lastThreshold)} -> ${config.formatPrice(currentThreshold)} (${direction})`,
      );

      // Send alert to all users with push tokens
      await this.sendThresholdAlert(
        baseAsset,
        currentThreshold,
        direction,
        config,
      );

      // Update stored threshold
      await this.updateThreshold(baseAsset, currentThreshold, currentPrice);
    }
  }

  private calculateThreshold(price: number, step: number): number {
    return Math.floor(price / step) * step;
  }

  private async updateThreshold(
    asset: string,
    thresholdLevel: number,
    price: number,
  ): Promise<void> {
    try {
      await this.priceThresholdModel.findOneAndUpdate(
        { asset },
        {
          asset,
          lastThresholdLevel: thresholdLevel,
          lastPrice: price,
          timestamp: new Date(),
        },
        { upsert: true },
      );
      this.lastThresholds.set(asset, thresholdLevel);
    } catch (error) {
      this.logger.error(`Failed to update threshold: ${error.message}`);
    }
  }

  private async sendThresholdAlert(
    asset: string,
    threshold: number,
    direction: 'up' | 'down',
    config: ThresholdConfig,
  ): Promise<void> {
    const arrow = direction === 'up' ? '↑' : '↓';
    const emoji = direction === 'up' ? '📈' : '📉';
    const verb = direction === 'up' ? 'subió' : 'bajó';

    const title = `${emoji} ${asset} ${arrow} ${config.formatPrice(threshold)}`;
    const body = `${asset} ${verb} a ${config.formatPrice(threshold)}`;

    // Get all users with push tokens
    const allTokens = await this.notificationsService.getAllUserTokens();

    if (allTokens.length === 0) {
      this.logger.debug('No push tokens registered, skipping alert');
      return;
    }

    this.logger.log(
      `Sending threshold alert for ${asset} to ${allTokens.length} tokens`,
    );

    const result = await this.firebaseService.sendMulticastNotification(
      allTokens,
      title,
      body,
      {
        type: 'threshold_alert',
        asset,
        threshold: threshold.toString(),
        direction,
      },
    );

    this.logger.log(
      `Threshold alert sent: ${result.successCount}/${allTokens.length} successful`,
    );
  }
}
