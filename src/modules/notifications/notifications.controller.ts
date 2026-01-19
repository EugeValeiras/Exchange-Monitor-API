import {
  Controller,
  Post,
  Delete,
  Get,
  Put,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
  Optional,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { NotificationsService } from './notifications.service';
import { FirebaseService } from './firebase.service';
import { BalancesService } from '../balances/balances.service';
import { SnapshotsService } from '../snapshots/snapshots.service';
import { UsersService } from '../users/users.service';
import { PriceAggregatorService } from '../prices/websocket/price-aggregator.service';
import { RegisterTokenDto } from './dto/register-token.dto';
import {
  NotificationSettingsDto,
  NotificationSettingsResponseDto,
} from './dto/notification-settings.dto';

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly firebaseService: FirebaseService,
    private readonly balancesService: BalancesService,
    private readonly snapshotsService: SnapshotsService,
    private readonly usersService: UsersService,
    @Optional() private readonly priceAggregator?: PriceAggregatorService,
  ) {}

  @Post('token')
  @HttpCode(HttpStatus.OK)
  async registerToken(
    @CurrentUser('userId') userId: string,
    @Body() dto: RegisterTokenDto,
  ): Promise<{ message: string }> {
    await this.notificationsService.registerToken(userId, dto.token);
    return { message: 'Token registered successfully' };
  }

  @Delete('token/:token')
  @HttpCode(HttpStatus.OK)
  async removeToken(
    @CurrentUser('userId') userId: string,
    @Param('token') token: string,
  ): Promise<{ message: string }> {
    await this.notificationsService.removeToken(userId, token);
    return { message: 'Token removed successfully' };
  }

  @Get('settings')
  async getSettings(
    @CurrentUser('userId') userId: string,
  ): Promise<NotificationSettingsResponseDto> {
    return this.notificationsService.getSettings(userId);
  }

  @Put('settings')
  async updateSettings(
    @CurrentUser('userId') userId: string,
    @Body() dto: NotificationSettingsDto,
  ): Promise<NotificationSettingsResponseDto> {
    return this.notificationsService.updateSettings(userId, dto);
  }

  // DEBUG: Test endpoint to send a notification
  @Post('test')
  @HttpCode(HttpStatus.OK)
  async testNotification(
    @CurrentUser('userId') userId: string,
  ): Promise<{ success: boolean; message: string }> {
    const tokens = await this.notificationsService.getUserTokens(userId);
    if (tokens.length === 0) {
      return { success: false, message: 'No push tokens registered' };
    }

    const token = tokens[0];
    const success = await this.firebaseService.sendNotification(
      token,
      'Test Notification',
      'This is a test notification from Exchange Monitor',
      { type: 'test' },
    );

    return {
      success,
      message: success
        ? 'Notification sent successfully'
        : 'Failed to send notification',
    };
  }

  // Endpoint to send silent push for widget refresh
  @Post('refresh-widget')
  @HttpCode(HttpStatus.OK)
  async refreshWidget(
    @CurrentUser('userId') userId: string,
  ): Promise<{ success: boolean; successCount: number; totalTokens: number }> {
    const tokens = await this.notificationsService.getUserTokens(userId);
    if (tokens.length === 0) {
      return { success: false, successCount: 0, totalTokens: 0 };
    }

    // Get widget data for this user
    const widgetData = await this.getWidgetDataForUser(userId);

    const result = await this.firebaseService.sendSilentPushMulticast(tokens, {
      action: 'refresh_widget',
      widgetData: JSON.stringify(widgetData),
    });

    return {
      success: result.successCount > 0,
      successCount: result.successCount,
      totalTokens: tokens.length,
    };
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
      } catch {
        // Chart data not available
      }

      // Get user's favorite assets
      let favoriteSymbols: string[] = [];
      try {
        favoriteSymbols = await this.usersService.getFavorites(userId);
      } catch {
        // Favorites not available
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
      const assetChartData: Map<string, number[]> = new Map();
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
      } catch {
        // Asset chart data not available
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
    } catch {
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
