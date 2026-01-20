import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { FirebaseService } from '../modules/notifications/firebase.service';
import { NotificationsService } from '../modules/notifications/notifications.service';
import { UsersService } from '../modules/users/users.service';
import { BalancesService } from '../modules/balances/balances.service';
import { SnapshotsService } from '../modules/snapshots/snapshots.service';
import { PriceAggregatorService } from '../modules/prices/websocket/price-aggregator.service';

@Injectable()
export class WidgetRefreshJob {
  private readonly logger = new Logger(WidgetRefreshJob.name);
  private readonly BALANCE_CHANGE_NOTIFICATION_THRESHOLD = 1000; // USD - for visible push notification
  private readonly WIDGET_UPDATE_THRESHOLD_PERCENT = 0.1; // % - for silent widget refresh
  private previousBalances: Map<string, number> = new Map();

  constructor(
    private readonly firebaseService: FirebaseService,
    private readonly notificationsService: NotificationsService,
    private readonly usersService: UsersService,
    private readonly balancesService: BalancesService,
    private readonly snapshotsService: SnapshotsService,
    @Optional() private readonly priceAggregator?: PriceAggregatorService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleWidgetRefresh(): Promise<void> {
    this.logger.log('Starting widget refresh job...');

    try {
      // Get all users with push tokens
      const users = await this.usersService.findUsersWithPushTokens();

      let totalTokens = 0;
      let totalSuccess = 0;

      for (const user of users) {
        const tokens = await this.notificationsService.getUserTokens(user.id);
        if (tokens.length === 0) continue;

        totalTokens += tokens.length;

        // Get widget data for this user
        const widgetData = await this.getWidgetDataForUser(user.id);
        const currentBalance = (widgetData as any).totalBalance || 0;
        const previousBalance = this.previousBalances.get(user.id);

        // Check for significant balance change (visible notification)
        await this.checkAndNotifyBalanceChange(
          user.id,
          tokens,
          currentBalance,
        );

        // Only send silent widget update if balance changed by at least 0.1%
        const shouldUpdateWidget = this.shouldSendWidgetUpdate(
          previousBalance,
          currentBalance,
        );

        if (shouldUpdateWidget) {
          const result = await this.firebaseService.sendSilentPushMulticast(
            tokens,
            {
              action: 'refresh_widget',
              widgetData: JSON.stringify(widgetData),
            },
          );
          totalSuccess += result.successCount;
        } else {
          this.logger.debug(
            `Skipping widget update for user ${user.id}: balance unchanged (${currentBalance.toFixed(2)})`,
          );
        }
      }

      this.logger.log(
        `Widget refresh completed: ${totalSuccess}/${totalTokens} tokens notified`,
      );
    } catch (error) {
      this.logger.error('Widget refresh job failed:', error);
    }
  }

  private async getWidgetDataForUser(userId: string): Promise<object> {
    try {
      // Get cached balance
      const cachedBalance = await this.balancesService.getCachedBalance(userId);

      if (!cachedBalance) {
        return this.getPlaceholderData();
      }

      // Recalculate total balance with latest prices from PriceAggregator
      let totalBalance = 0;
      if (this.priceAggregator) {
        for (const asset of cachedBalance.data.byAsset) {
          const priceData = this.priceAggregator.getLatestPrice(`${asset.asset}/USDT`) ||
                            this.priceAggregator.getLatestPrice(`${asset.asset}/USD`);
          const price = priceData?.price || asset.priceUsd || 0;
          totalBalance += asset.total * price;
        }
      } else {
        totalBalance = cachedBalance.data.totalValueUsd;
      }

      // Get 24h chart data from snapshots
      let change24hPercent = 0;
      let change24hUsd = 0;
      let chartDataPoints: number[] = [];

      try {
        const chartResponse = await this.snapshotsService.getChartData(
          userId,
          '24h',
        );
        change24hPercent = chartResponse.changePercent || 0;
        change24hUsd = chartResponse.changeUsd || 0;
        // Downsample to ~24 points for the widget chart
        chartDataPoints = this.downsampleData(chartResponse.data, 24);
      } catch (e) {
        this.logger.debug(`Could not get chart data for user ${userId}`);
      }

      // Get user's favorite assets
      let favoriteSymbols: string[] = [];
      try {
        favoriteSymbols = await this.usersService.getFavorites(userId);
      } catch (e) {
        this.logger.debug(`Could not get favorites for user ${userId}`);
      }

      // Fallback to top 3 by value if no favorites
      if (favoriteSymbols.length === 0) {
        favoriteSymbols = cachedBalance.data.byAsset
          .filter((a) => a.valueUsd && a.valueUsd > 0)
          .sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0))
          .slice(0, 3)
          .map((a) => a.asset);
      }

      // Limit to first 3 favorites for widget
      favoriteSymbols = favoriteSymbols.slice(0, 3);

      // Get chart data by asset for sparklines
      let assetChartData: Map<string, number[]> = new Map();
      try {
        const assetChartResponse = await this.snapshotsService.getChartDataByAsset(
          userId,
          '24h',
          favoriteSymbols,
        );
        for (const assetData of assetChartResponse.assetData) {
          assetChartData.set(
            assetData.asset.toUpperCase(),
            this.downsampleData(assetData.data, 24),
          );
        }
      } catch (e) {
        this.logger.debug(`Could not get asset chart data for user ${userId}`);
      }

      // Build asset data from favorites
      const assets = favoriteSymbols.map((symbol) => {
        // Get price and change24h from PriceAggregator
        let price = 0;
        let change24h = 0;
        if (this.priceAggregator) {
          const priceData = this.priceAggregator.getLatestPrice(`${symbol}/USDT`) ||
                            this.priceAggregator.getLatestPrice(`${symbol}/USD`);
          price = priceData?.price || 0;
          change24h = priceData?.change24h || 0;
        }

        // Fallback to cached balance price if no realtime price
        if (price === 0) {
          const balanceAsset = cachedBalance.data.byAsset.find(
            (a) => a.asset.toUpperCase() === symbol.toUpperCase(),
          );
          price = balanceAsset?.priceUsd || 0;
        }

        // Get sparkline from asset chart data
        const sparkline = assetChartData.get(symbol.toUpperCase()) || [];

        return {
          symbol,
          name: this.getAssetName(symbol),
          price,
          change24h,
          sparkline,
        };
      });

      return {
        totalBalance,
        change24hPercent,
        change24hUsd,
        chartData: chartDataPoints,
        assets,
        lastUpdated: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error(`Error getting widget data for user ${userId}: ${error.message}`);
      return this.getPlaceholderData();
    }
  }

  private downsampleData(data: number[], targetPoints: number): number[] {
    if (!data || data.length === 0) return [];
    if (data.length <= targetPoints) return data;

    const result: number[] = [];
    const step = data.length / targetPoints;

    for (let i = 0; i < targetPoints; i++) {
      const index = Math.min(Math.floor(i * step), data.length - 1);
      result.push(data[index]);
    }

    // Ensure last point is the actual last value
    result[result.length - 1] = data[data.length - 1];
    return result;
  }

  private getPlaceholderData(): object {
    return {
      totalBalance: 0,
      change24hPercent: 0,
      change24hUsd: 0,
      chartData: [],
      assets: [],
      lastUpdated: new Date().toISOString(),
    };
  }

  private getAssetName(symbol: string): string {
    const names: Record<string, string> = {
      BTC: 'Bitcoin',
      ETH: 'Ethereum',
      NEXO: 'NEXO Token',
      SOL: 'Solana',
      USDT: 'Tether',
      USDC: 'USD Coin',
      MON: 'Monad',
    };
    return names[symbol] || symbol;
  }

  private shouldSendWidgetUpdate(
    previousBalance: number | undefined,
    currentBalance: number,
  ): boolean {
    // Always send on first run (no previous balance)
    if (previousBalance === undefined) {
      return true;
    }

    // Avoid division by zero
    if (previousBalance === 0) {
      return currentBalance > 0;
    }

    const percentChange = Math.abs(
      ((currentBalance - previousBalance) / previousBalance) * 100,
    );

    return percentChange >= this.WIDGET_UPDATE_THRESHOLD_PERCENT;
  }

  private async checkAndNotifyBalanceChange(
    userId: string,
    tokens: string[],
    currentBalance: number,
  ): Promise<void> {
    const previousBalance = this.previousBalances.get(userId);

    // Store current balance for next comparison
    this.previousBalances.set(userId, currentBalance);

    // Skip if no previous balance (first run for this user)
    if (previousBalance === undefined) {
      this.logger.debug(
        `First balance recorded for user ${userId}: $${currentBalance.toFixed(2)}`,
      );
      return;
    }

    const balanceChange = currentBalance - previousBalance;
    const absChange = Math.abs(balanceChange);

    // Check if change exceeds threshold
    if (absChange >= this.BALANCE_CHANGE_NOTIFICATION_THRESHOLD) {
      const direction = balanceChange > 0 ? 'increased' : 'decreased';
      const emoji = balanceChange > 0 ? '📈' : '📉';
      const sign = balanceChange > 0 ? '+' : '';
      const percentChange = previousBalance > 0
        ? ((balanceChange / previousBalance) * 100).toFixed(2)
        : '0.00';

      const title = `${emoji} Portfolio ${direction}`;
      const body = `${sign}$${absChange.toFixed(2)} (${sign}${percentChange}%) • Now: $${currentBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

      this.logger.log(
        `Balance change alert for user ${userId}: ${sign}$${absChange.toFixed(2)} (${sign}${percentChange}%) - Now: $${currentBalance.toFixed(2)}`,
      );

      await this.firebaseService.sendMulticastNotification(
        tokens,
        title,
        body,
        {
          action: 'balance_change',
          change: balanceChange.toFixed(2),
          changePercent: percentChange,
          previousBalance: previousBalance.toFixed(2),
          currentBalance: currentBalance.toFixed(2),
        },
      );
    }
  }
}
