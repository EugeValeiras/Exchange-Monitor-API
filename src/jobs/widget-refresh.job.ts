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

        const result = await this.firebaseService.sendSilentPushMulticast(
          tokens,
          {
            action: 'refresh_widget',
            widgetData: JSON.stringify(widgetData),
          },
        );

        totalSuccess += result.successCount;
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

      // DEMO: Divide balance by 10 to hide real amounts
      totalBalance = totalBalance / 10;

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
        change24hUsd = chartResponse.changeUsd || 0; // Already /10 from SnapshotsService
        // Downsample to ~24 points for the widget chart (already /10 from SnapshotsService)
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
}
