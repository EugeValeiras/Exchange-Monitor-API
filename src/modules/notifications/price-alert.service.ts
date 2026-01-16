import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { OnEvent } from '@nestjs/event-emitter';
import { FirebaseService } from './firebase.service';
import { UsersService } from '../users/users.service';
import { PriceBaseline, PriceBaselineDocument } from './schemas/price-baseline.schema';
import { AggregatedPrice } from '../prices/websocket/exchange-stream.interface';

interface AlertCooldown {
  lastAlertTime: number;
  lastAlertPrice: number;
}

@Injectable()
export class PriceAlertService implements OnModuleInit {
  private readonly logger = new Logger(PriceAlertService.name);

  // In-memory price baselines for quick access
  private priceBaselines = new Map<string, number>();

  // Cooldown tracking: userId:asset -> last alert time
  private alertCooldowns = new Map<string, AlertCooldown>();

  // Cooldown period: 60 minutes
  private readonly COOLDOWN_MS = 60 * 60 * 1000;

  constructor(
    @InjectModel(PriceBaseline.name)
    private priceBaselineModel: Model<PriceBaselineDocument>,
    private readonly firebaseService: FirebaseService,
    private readonly usersService: UsersService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.loadBaselinesFromDb();
  }

  private async loadBaselinesFromDb(): Promise<void> {
    try {
      const baselines = await this.priceBaselineModel.find().exec();
      baselines.forEach((baseline) => {
        this.priceBaselines.set(baseline.symbol, baseline.price);
      });
      this.logger.log(`Loaded ${baselines.length} price baselines from database`);
    } catch (error) {
      this.logger.error(`Failed to load baselines: ${error.message}`);
    }
  }

  @OnEvent('price.update')
  async handlePriceUpdate(priceData: AggregatedPrice): Promise<void> {
    if (!this.firebaseService.isReady()) {
      return;
    }

    const symbol = priceData.symbol;
    const baseAsset = symbol.split('/')[0];
    const currentPrice = priceData.price;

    // Get or set baseline
    const baseline = this.priceBaselines.get(symbol);

    if (!baseline) {
      // First time seeing this symbol, set baseline
      await this.updateBaseline(symbol, currentPrice);
      return;
    }

    // Calculate percentage change
    const percentChange = ((currentPrice - baseline) / baseline) * 100;
    const absPercentChange = Math.abs(percentChange);

    // Find users with this asset as favorite and notifications enabled
    const usersToNotify = await this.findUsersToNotify(baseAsset, absPercentChange);

    if (usersToNotify.length > 0) {
      await this.sendPriceAlerts(usersToNotify, baseAsset, currentPrice, percentChange);
    }

    // Update baseline if significant change occurred
    if (absPercentChange >= 5) {
      await this.updateBaseline(symbol, currentPrice);
    }
  }

  private async findUsersToNotify(
    asset: string,
    percentChange: number,
  ): Promise<Array<{ userId: string; tokens: string[]; threshold: number }>> {
    try {
      const users = await this.usersService.findUsersWithFavoriteAsset(asset);

      return users
        .filter((user) => {
          // Check if notifications are enabled
          if (!user.notificationSettings?.enabled) return false;

          // Check if change exceeds user's threshold
          const threshold = user.notificationSettings.priceChangeThreshold || 5;
          if (percentChange < threshold) return false;

          // Check if user has push tokens
          if (!user.pushTokens || user.pushTokens.length === 0) return false;

          // Check cooldown
          const cooldownKey = `${user._id}:${asset}`;
          const cooldown = this.alertCooldowns.get(cooldownKey);
          if (cooldown && Date.now() - cooldown.lastAlertTime < this.COOLDOWN_MS) {
            return false;
          }

          // Check quiet hours
          if (!this.isOutsideQuietHours(user.notificationSettings)) {
            return false;
          }

          return true;
        })
        .map((user) => ({
          userId: user._id.toString(),
          tokens: user.pushTokens,
          threshold: user.notificationSettings.priceChangeThreshold || 5,
        }));
    } catch (error) {
      this.logger.error(`Failed to find users to notify: ${error.message}`);
      return [];
    }
  }

  private isOutsideQuietHours(settings: {
    quietHoursStart?: string;
    quietHoursEnd?: string;
  }): boolean {
    if (!settings.quietHoursStart || !settings.quietHoursEnd) {
      return true;
    }

    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    const currentTime = currentHour * 60 + currentMinute;

    const [startHour, startMinute] = settings.quietHoursStart.split(':').map(Number);
    const [endHour, endMinute] = settings.quietHoursEnd.split(':').map(Number);
    const startTime = startHour * 60 + startMinute;
    const endTime = endHour * 60 + endMinute;

    // Handle case where quiet hours cross midnight
    if (startTime > endTime) {
      // Quiet hours cross midnight (e.g., 22:00 - 07:00)
      return currentTime >= endTime && currentTime < startTime;
    } else {
      // Normal quiet hours (e.g., 23:00 - 06:00)
      return currentTime < startTime || currentTime >= endTime;
    }
  }

  private async sendPriceAlerts(
    users: Array<{ userId: string; tokens: string[]; threshold: number }>,
    asset: string,
    price: number,
    percentChange: number,
  ): Promise<void> {
    const direction = percentChange > 0 ? '📈' : '📉';
    const sign = percentChange > 0 ? '+' : '';
    const title = `${direction} ${asset} Price Alert`;
    const body = `${asset} moved ${sign}${percentChange.toFixed(2)}% to $${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    const allTokens: string[] = [];
    const userTokenMap = new Map<string, string[]>();

    users.forEach((user) => {
      allTokens.push(...user.tokens);
      userTokenMap.set(user.userId, user.tokens);
    });

    this.logger.log(
      `Price alert triggered for ${asset}: ${percentChange.toFixed(2)}% (${users.length} users, ${allTokens.length} tokens)`,
    );

    const result = await this.firebaseService.sendMulticastNotification(
      allTokens,
      title,
      body,
      {
        type: 'price_alert',
        asset,
        price: price.toString(),
        percentChange: percentChange.toString(),
      },
    );

    // Update cooldowns for successfully notified users
    users.forEach((user) => {
      const cooldownKey = `${user.userId}:${asset}`;
      this.alertCooldowns.set(cooldownKey, {
        lastAlertTime: Date.now(),
        lastAlertPrice: price,
      });
    });

    // Handle failed tokens (remove invalid tokens from users)
    if (result.failedTokens.length > 0) {
      this.logger.warn(`Failed to send to ${result.failedTokens.length} tokens`);
      await this.cleanupInvalidTokens(result.failedTokens, userTokenMap);
    }
  }

  private async cleanupInvalidTokens(
    failedTokens: string[],
    userTokenMap: Map<string, string[]>,
  ): Promise<void> {
    for (const [userId, tokens] of userTokenMap) {
      const invalidTokens = tokens.filter((t) => failedTokens.includes(t));
      for (const token of invalidTokens) {
        try {
          await this.usersService.removePushToken(userId, token);
          this.logger.debug(`Removed invalid token for user ${userId}`);
        } catch (error) {
          this.logger.error(`Failed to remove invalid token: ${error.message}`);
        }
      }
    }
  }

  private async updateBaseline(symbol: string, price: number): Promise<void> {
    try {
      await this.priceBaselineModel.findOneAndUpdate(
        { symbol },
        { symbol, price, timestamp: new Date() },
        { upsert: true },
      );
      this.priceBaselines.set(symbol, price);
      this.logger.debug(`Updated baseline for ${symbol}: $${price}`);
    } catch (error) {
      this.logger.error(`Failed to update baseline: ${error.message}`);
    }
  }

}
