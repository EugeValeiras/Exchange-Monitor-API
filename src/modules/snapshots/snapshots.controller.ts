import { Controller, Get, Post, Body, Param, Query, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
  ApiBody,
} from '@nestjs/swagger';
import { SnapshotsService } from './snapshots.service';
import {
  SnapshotResponseDto,
  SnapshotCompareDto,
  ChartDataResponseDto,
  ChartDataByAssetResponseDto,
  Pnl24hResponseDto,
  RebuildHistoryRequestDto,
  RebuildHistoryResponseDto,
} from './dto/snapshot-response.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('snapshots')
@Controller('api/snapshots')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class SnapshotsController {
  constructor(private readonly snapshotsService: SnapshotsService) {}

  @Get()
  @ApiOperation({ summary: 'Get all daily snapshots' })
  @ApiResponse({ status: 200, type: [SnapshotResponseDto] })
  async findAll(
    @CurrentUser('userId') userId: string,
  ): Promise<SnapshotResponseDto[]> {
    return this.snapshotsService.findAllByUser(userId);
  }

  @Get('latest')
  @ApiOperation({ summary: 'Get the latest snapshot' })
  @ApiResponse({ status: 200, type: SnapshotResponseDto })
  async findLatest(
    @CurrentUser('userId') userId: string,
  ): Promise<SnapshotResponseDto | null> {
    return this.snapshotsService.findLatest(userId);
  }

  @Get('compare')
  @ApiOperation({ summary: 'Compare snapshots between two dates' })
  @ApiQuery({ name: 'from', example: '2024-01-01' })
  @ApiQuery({ name: 'to', example: '2024-01-15' })
  @ApiResponse({ status: 200, type: SnapshotCompareDto })
  async compare(
    @Query('from') fromDate: string,
    @Query('to') toDate: string,
    @CurrentUser('userId') userId: string,
  ): Promise<SnapshotCompareDto> {
    return this.snapshotsService.compare(userId, fromDate, toDate);
  }

  @Get('chart-data')
  @ApiOperation({ summary: 'Get chart data for balance history' })
  @ApiQuery({
    name: 'timeframe',
    enum: ['24h', '7d', '1m', '1y'],
    example: '24h',
  })
  @ApiResponse({ status: 200, type: ChartDataResponseDto })
  async getChartData(
    @Query('timeframe') timeframe: '24h' | '7d' | '1m' | '1y' = '24h',
    @CurrentUser('userId') userId: string,
  ): Promise<ChartDataResponseDto> {
    return this.snapshotsService.getChartData(userId, timeframe);
  }

  @Get('chart-data-by-asset')
  @ApiOperation({ summary: 'Get chart data with asset breakdown' })
  @ApiQuery({
    name: 'timeframe',
    enum: ['24h', '7d'],
    example: '24h',
  })
  @ApiQuery({
    name: 'assets',
    required: false,
    isArray: true,
    description: 'Filter by specific assets (comma-separated)',
  })
  @ApiResponse({ status: 200, type: ChartDataByAssetResponseDto })
  async getChartDataByAsset(
    @Query('timeframe') timeframe: '24h' | '7d' = '24h',
    @Query('assets') assets?: string | string[],
    @CurrentUser('userId') userId?: string,
  ): Promise<ChartDataByAssetResponseDto> {
    // Handle both comma-separated string and array
    let assetList: string[] | undefined;
    if (assets) {
      if (typeof assets === 'string') {
        assetList = assets.split(',').map((a) => a.trim());
      } else {
        assetList = assets;
      }
    }
    return this.snapshotsService.getChartDataByAsset(userId!, timeframe, assetList);
  }

  @Get('pnl-24h')
  @ApiOperation({ summary: 'Get 24h PNL (balance change in last 24 hours)' })
  @ApiResponse({ status: 200, type: Pnl24hResponseDto })
  async get24hPnl(
    @CurrentUser('userId') userId: string,
  ): Promise<Pnl24hResponseDto> {
    return this.snapshotsService.get24hPnl(userId);
  }

  @Post('generate')
  @ApiOperation({ summary: 'Generate a snapshot manually' })
  @ApiResponse({ status: 201, type: SnapshotResponseDto })
  async generate(
    @CurrentUser('userId') userId: string,
  ): Promise<SnapshotResponseDto> {
    const snapshot = await this.snapshotsService.generateSnapshot(userId);
    return {
      id: snapshot._id.toString(),
      date: snapshot.date,
      snapshotAt: snapshot.snapshotAt,
      exchangeBalances: snapshot.exchangeBalances.map((eb) => ({
        exchange: eb.exchange,
        label: eb.label,
        credentialId: eb.credentialId?.toString() || '',
        balances: eb.balances,
        totalValueUsd: eb.totalValueUsd,
      })),
      consolidatedBalances: snapshot.consolidatedBalances,
      totalValueUsd: snapshot.totalValueUsd,
      pricesAtSnapshot: snapshot.pricesAtSnapshot,
    };
  }

  @Post('rebuild-history')
  @ApiOperation({
    summary: 'Rebuild historical balance snapshots from transactions',
    description:
      'Reconstructs daily balance snapshots by processing all transactions chronologically. ' +
      'Gets historical prices from Binance for accurate USD valuations. ' +
      'This operation may take several minutes depending on the transaction history.',
  })
  @ApiBody({ type: RebuildHistoryRequestDto })
  @ApiResponse({ status: 201, type: RebuildHistoryResponseDto })
  async rebuildHistory(
    @CurrentUser('userId') userId: string,
    @Body() body: RebuildHistoryRequestDto,
  ): Promise<RebuildHistoryResponseDto> {
    return this.snapshotsService.rebuildHistory(userId, {
      fromDate: body.fromDate,
      skipExisting: body.skipExisting,
    });
  }

  @Get(':date')
  @ApiOperation({ summary: 'Get snapshot by date (YYYY-MM-DD)' })
  @ApiResponse({ status: 200, type: SnapshotResponseDto })
  @ApiResponse({ status: 404, description: 'Snapshot not found' })
  async findByDate(
    @Param('date') date: string,
    @CurrentUser('userId') userId: string,
  ): Promise<SnapshotResponseDto> {
    return this.snapshotsService.findByDate(userId, date);
  }
}
