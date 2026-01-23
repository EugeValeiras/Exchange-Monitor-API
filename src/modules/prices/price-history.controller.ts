import {
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
  NotFoundException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { PriceHistoryService } from './price-history.service';
import {
  PriceHistoryInitializerService,
  InitializationSummary,
} from './price-history-initializer.service';
import {
  PriceHistoryQueryDto,
  PriceHistoryResponseDto,
  PriceHistoryChartQueryDto,
  PriceHistoryChartResponseDto,
  PriceAtQueryDto,
  PriceAtResponseDto,
} from './dto/price-history.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

@ApiTags('prices')
@Controller('prices/history')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class PriceHistoryController {
  constructor(
    private readonly priceHistoryService: PriceHistoryService,
    private readonly priceHistoryInitializerService: PriceHistoryInitializerService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Get price history for a symbol' })
  @ApiResponse({ status: 200, type: PriceHistoryResponseDto })
  async getHistory(
    @Query() query: PriceHistoryQueryDto,
  ): Promise<PriceHistoryResponseDto> {
    return this.priceHistoryService.getHistory(query);
  }

  @Get('chart')
  @ApiOperation({ summary: 'Get chart data for a symbol' })
  @ApiResponse({ status: 200, type: PriceHistoryChartResponseDto })
  async getChartData(
    @Query() query: PriceHistoryChartQueryDto,
  ): Promise<PriceHistoryChartResponseDto> {
    return this.priceHistoryService.getChartData(query);
  }

  @Get('at')
  @ApiOperation({ summary: 'Get price at a specific timestamp' })
  @ApiResponse({ status: 200, type: PriceAtResponseDto })
  @ApiResponse({ status: 404, description: 'No price found for the given timestamp' })
  async getPriceAt(
    @Query() query: PriceAtQueryDto,
  ): Promise<PriceAtResponseDto> {
    const result = await this.priceHistoryService.getPriceAt(query);

    if (!result) {
      throw new NotFoundException(
        `No price found for ${query.symbol} at or before ${query.timestamp}`,
      );
    }

    return result;
  }

  @Post('initialize')
  @ApiOperation({
    summary: 'Initialize historical price data from exchange APIs',
    description:
      'Fetches historical klines/OHLC data from Binance and Kraken for all configured symbols. ' +
      'This can take several minutes depending on the number of symbols and days requested.',
  })
  @ApiQuery({
    name: 'days',
    required: false,
    type: Number,
    description: 'Number of days to fetch (default: 7, max: 180)',
  })
  @ApiResponse({ status: 201, description: 'Initialization completed' })
  async initializeHistoricalData(
    @Query('days') days?: number,
  ): Promise<InitializationSummary> {
    return this.priceHistoryInitializerService.initializeHistoricalData(
      days || 7,
    );
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get price history statistics' })
  @ApiResponse({ status: 200, description: 'Statistics retrieved' })
  async getStatistics(): Promise<{
    totalRecords: number;
    byExchange: Record<string, number>;
    bySymbol: Record<string, number>;
    oldestRecord: Date | null;
    newestRecord: Date | null;
  }> {
    return this.priceHistoryInitializerService.getStatistics();
  }
}
