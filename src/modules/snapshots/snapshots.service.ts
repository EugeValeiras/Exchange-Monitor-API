import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  DailySnapshot,
  DailySnapshotDocument,
  AssetBalance,
  ExchangeBalance,
} from './schemas/daily-snapshot.schema';
import {
  HourlySnapshot,
  HourlySnapshotDocument,
  SnapshotAssetBalance,
} from './schemas/hourly-snapshot.schema';
import { BalancesService } from '../balances/balances.service';
import { PricesService } from '../prices/prices.service';
import {
  SnapshotResponseDto,
  SnapshotCompareDto,
  ChartDataResponseDto,
  ChartDataByAssetResponseDto,
  AssetChartDataDto,
} from './dto/snapshot-response.dto';

@Injectable()
export class SnapshotsService {
  private readonly logger = new Logger(SnapshotsService.name);

  constructor(
    @InjectModel(DailySnapshot.name)
    private snapshotModel: Model<DailySnapshotDocument>,
    @InjectModel(HourlySnapshot.name)
    private hourlySnapshotModel: Model<HourlySnapshotDocument>,
    private readonly balancesService: BalancesService,
    private readonly pricesService: PricesService,
  ) {}

  async generateSnapshot(userId: string | Types.ObjectId): Promise<DailySnapshotDocument> {
    const userIdStr = userId.toString();
    const today = new Date().toISOString().split('T')[0];

    // Check if snapshot already exists
    const existing = await this.snapshotModel.findOne({
      userId: new Types.ObjectId(userIdStr),
      date: today,
    });

    if (existing) {
      this.logger.log(`Snapshot for ${today} already exists, updating...`);
    }

    // Get balances
    const consolidated = await this.balancesService.getConsolidatedBalances(userIdStr);

    // Get all unique assets
    const assets = new Set<string>();
    for (const balance of consolidated.byAsset) {
      assets.add(balance.asset);
    }

    // Get prices
    const pricesMap = await this.pricesService.getPricesMap(Array.from(assets));

    // Build exchange balances with USD values
    const exchangeBalances: ExchangeBalance[] = consolidated.byExchange.map((eb) => {
      const balances: AssetBalance[] = eb.balances.map((b) => ({
        asset: b.asset,
        amount: b.total,
        priceUsd: pricesMap[b.asset] || 0,
        valueUsd: b.total * (pricesMap[b.asset] || 0),
      }));

      return {
        exchange: eb.exchange,
        credentialId: new Types.ObjectId(eb.credentialId),
        label: eb.label,
        balances,
        totalValueUsd: balances.reduce((sum, b) => sum + (b.valueUsd || 0), 0),
      };
    });

    // Build consolidated balances with USD values
    const consolidatedBalances: AssetBalance[] = consolidated.byAsset.map((b) => ({
      asset: b.asset,
      amount: b.total,
      priceUsd: pricesMap[b.asset] || 0,
      valueUsd: b.total * (pricesMap[b.asset] || 0),
    }));

    const totalValueUsd = consolidatedBalances.reduce(
      (sum, b) => sum + (b.valueUsd || 0),
      0,
    );

    const snapshotData = {
      userId: new Types.ObjectId(userIdStr),
      date: today,
      snapshotAt: new Date(),
      exchangeBalances,
      consolidatedBalances,
      totalValueUsd,
      pricesAtSnapshot: pricesMap,
    };

    if (existing) {
      Object.assign(existing, snapshotData);
      return existing.save();
    }

    const snapshot = new this.snapshotModel(snapshotData);
    return snapshot.save();
  }

  async findAllByUser(userId: string): Promise<SnapshotResponseDto[]> {
    const snapshots = await this.snapshotModel
      .find({ userId: new Types.ObjectId(userId) })
      .sort({ date: -1 });

    return snapshots.map((s) => this.toResponse(s));
  }

  async findLatest(userId: string): Promise<SnapshotResponseDto | null> {
    const snapshot = await this.snapshotModel
      .findOne({ userId: new Types.ObjectId(userId) })
      .sort({ date: -1 });

    return snapshot ? this.toResponse(snapshot) : null;
  }

  async findByDate(userId: string, date: string): Promise<SnapshotResponseDto> {
    const snapshot = await this.snapshotModel.findOne({
      userId: new Types.ObjectId(userId),
      date,
    });

    if (!snapshot) {
      throw new NotFoundException(`Snapshot for ${date} not found`);
    }

    return this.toResponse(snapshot);
  }

  async compare(
    userId: string,
    fromDate: string,
    toDate: string,
  ): Promise<SnapshotCompareDto> {
    const [fromSnapshot, toSnapshot] = await Promise.all([
      this.findByDate(userId, fromDate),
      this.findByDate(userId, toDate),
    ]);

    const changeUsd = toSnapshot.totalValueUsd - fromSnapshot.totalValueUsd;
    const changePercent =
      fromSnapshot.totalValueUsd > 0
        ? (changeUsd / fromSnapshot.totalValueUsd) * 100
        : 0;

    // Build asset changes
    const fromAssets = new Map(
      fromSnapshot.consolidatedBalances.map((b) => [b.asset, b.amount]),
    );
    const toAssets = new Map(
      toSnapshot.consolidatedBalances.map((b) => [b.asset, b.amount]),
    );

    const allAssets = new Set([...fromAssets.keys(), ...toAssets.keys()]);
    const assetChanges = Array.from(allAssets).map((asset) => ({
      asset,
      fromAmount: fromAssets.get(asset) || 0,
      toAmount: toAssets.get(asset) || 0,
      change: (toAssets.get(asset) || 0) - (fromAssets.get(asset) || 0),
    }));

    return {
      fromDate,
      toDate,
      fromTotalUsd: fromSnapshot.totalValueUsd,
      toTotalUsd: toSnapshot.totalValueUsd,
      changeUsd,
      changePercent,
      assetChanges,
    };
  }

  async findUsersWithoutSnapshotForDate(date: string): Promise<string[]> {
    // This would require access to the users collection
    // For simplicity, we'll return empty array - implement as needed
    return [];
  }

  // ==================== HOURLY SNAPSHOTS ====================

  async generateHourlySnapshot(
    userId: string | Types.ObjectId,
  ): Promise<HourlySnapshotDocument> {
    const userIdStr = userId.toString();
    const now = new Date();

    // Get balances
    const consolidated = await this.balancesService.getConsolidatedBalances(userIdStr);

    // Get all unique assets
    const assets = consolidated.byAsset.map((b) => b.asset);

    // Get prices
    const pricesMap = await this.pricesService.getPricesMap(assets);

    // Calculate all asset balances with USD values
    const assetBalances: SnapshotAssetBalance[] = consolidated.byAsset.map((b) => ({
      asset: b.asset,
      amount: b.total,
      priceUsd: pricesMap[b.asset] || 0,
      valueUsd: b.total * (pricesMap[b.asset] || 0),
    }));

    const totalValueUsd = assetBalances.reduce((sum, a) => sum + a.valueUsd, 0);

    // Get top 5 assets by value (for backwards compatibility)
    const topAssets = [...assetBalances]
      .sort((a, b) => b.valueUsd - a.valueUsd)
      .slice(0, 5)
      .map((a) => ({ asset: a.asset, valueUsd: a.valueUsd }));

    const snapshot = new this.hourlySnapshotModel({
      userId: new Types.ObjectId(userIdStr),
      timestamp: now,
      totalValueUsd,
      topAssets,
      assetBalances,
    });

    return snapshot.save();
  }

  // ==================== CHART DATA ====================

  async getChartData(
    userId: string,
    timeframe: '24h' | '7d' | '1m' | '1y',
  ): Promise<ChartDataResponseDto> {
    switch (timeframe) {
      case '24h':
        return this.get24hChartData(userId);
      case '7d':
        return this.get7dChartData(userId);
      case '1m':
        return this.get1mChartData(userId);
      case '1y':
        return this.get1yChartData(userId);
      default:
        return this.get24hChartData(userId);
    }
  }

  async get24hPnl(userId: string): Promise<{
    currentValue: number;
    value24hAgo: number;
    changeUsd: number;
    changePercent: number;
  }> {
    // Get snapshot closest to 24h ago
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const snapshot = await this.hourlySnapshotModel
      .findOne({
        userId: new Types.ObjectId(userId),
        timestamp: { $lte: since },
      })
      .sort({ timestamp: -1 });

    // Get current balance
    const current = await this.balancesService.getConsolidatedBalances(userId);
    const currentValue = current.totalValueUsd;
    const value24hAgo = snapshot?.totalValueUsd || currentValue;

    const changeUsd = currentValue - value24hAgo;
    const changePercent = value24hAgo > 0 ? (changeUsd / value24hAgo) * 100 : 0;

    return {
      currentValue,
      value24hAgo,
      changeUsd,
      changePercent,
    };
  }

  async getChartDataByAsset(
    userId: string,
    timeframe: '24h' | '7d',
    assets?: string[],
  ): Promise<ChartDataByAssetResponseDto> {
    const since =
      timeframe === '24h'
        ? new Date(Date.now() - 24 * 60 * 60 * 1000)
        : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const snapshots = await this.hourlySnapshotModel
      .find({
        userId: new Types.ObjectId(userId),
        timestamp: { $gte: since },
      })
      .sort({ timestamp: 1 });

    // Collect all available assets from snapshots
    const allAssets = new Set<string>();
    snapshots.forEach((s) => {
      s.assetBalances?.forEach((ab) => allAssets.add(ab.asset));
    });

    const availableAssets = Array.from(allAssets).sort();
    const filteredAssets =
      assets && assets.length > 0 ? assets : availableAssets;

    // Build data per asset
    const assetData: AssetChartDataDto[] = filteredAssets.map((asset) => ({
      asset,
      data: snapshots.map((s) => {
        const ab = s.assetBalances?.find((a) => a.asset === asset);
        return ab?.valueUsd || 0;
      }),
    }));

    // Build total data and calculate change
    const totalData = snapshots.map((s) => s.totalValueUsd);
    const labels = snapshots.map((s) => s.timestamp.toISOString());

    const firstValue = totalData[0] || 0;
    const lastValue = totalData[totalData.length - 1] || 0;
    const changeUsd = lastValue - firstValue;
    const changePercent = firstValue > 0 ? (changeUsd / firstValue) * 100 : 0;

    return {
      labels,
      totalData,
      assetData,
      changeUsd,
      changePercent,
      timeframe,
      availableAssets,
    };
  }

  private async get24hChartData(userId: string): Promise<ChartDataResponseDto> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const snapshots = await this.hourlySnapshotModel
      .find({
        userId: new Types.ObjectId(userId),
        timestamp: { $gte: since },
      })
      .sort({ timestamp: 1 });

    // Map to the expected format
    const data = snapshots.map((s) => ({
      timestamp: s.timestamp,
      totalValueUsd: s.totalValueUsd,
    }));

    return this.buildChartResponse(data, '24h');
  }

  private async get7dChartData(userId: string): Promise<ChartDataResponseDto> {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // Get hourly snapshots
    const snapshots = await this.hourlySnapshotModel
      .find({
        userId: new Types.ObjectId(userId),
        timestamp: { $gte: since },
      })
      .sort({ timestamp: 1 });

    // Only aggregate if we have enough data points (>24), otherwise show all
    let data: { timestamp: Date; totalValueUsd: number }[];
    if (snapshots.length > 24) {
      data = this.aggregateSnapshots(snapshots, 6);
    } else {
      data = snapshots.map((s) => ({
        timestamp: s.timestamp,
        totalValueUsd: s.totalValueUsd,
      }));
    }

    return this.buildChartResponse(data, '7d');
  }

  private async get1mChartData(userId: string): Promise<ChartDataResponseDto> {
    const since = new Date();
    since.setDate(since.getDate() - 30);
    const sinceDate = since.toISOString().split('T')[0];

    const snapshots = await this.snapshotModel
      .find({
        userId: new Types.ObjectId(userId),
        date: { $gte: sinceDate },
      })
      .sort({ date: 1 });

    const data = snapshots.map((s) => ({
      timestamp: new Date(s.date),
      totalValueUsd: s.totalValueUsd,
    }));

    return this.buildChartResponse(data, '1m');
  }

  private async get1yChartData(userId: string): Promise<ChartDataResponseDto> {
    const since = new Date();
    since.setFullYear(since.getFullYear() - 1);
    const sinceDate = since.toISOString().split('T')[0];

    const snapshots = await this.snapshotModel
      .find({
        userId: new Types.ObjectId(userId),
        date: { $gte: sinceDate },
      })
      .sort({ date: 1 });

    // Aggregate to weekly (every 7 days)
    const data = snapshots.map((s) => ({
      timestamp: new Date(s.date),
      totalValueUsd: s.totalValueUsd,
    }));

    const aggregated = this.aggregateByWeek(data);

    return this.buildChartResponse(aggregated, '1y');
  }

  private aggregateSnapshots(
    snapshots: HourlySnapshotDocument[],
    interval: number,
  ): { timestamp: Date; totalValueUsd: number }[] {
    if (snapshots.length === 0) return [];

    const result: { timestamp: Date; totalValueUsd: number }[] = [];
    for (let i = 0; i < snapshots.length; i += interval) {
      const chunk = snapshots.slice(i, i + interval);
      const avgValue =
        chunk.reduce((sum, s) => sum + s.totalValueUsd, 0) / chunk.length;
      result.push({
        timestamp: chunk[Math.floor(chunk.length / 2)].timestamp,
        totalValueUsd: avgValue,
      });
    }
    return result;
  }

  private aggregateByWeek(
    data: { timestamp: Date; totalValueUsd: number }[],
  ): { timestamp: Date; totalValueUsd: number }[] {
    if (data.length === 0) return [];

    const result: { timestamp: Date; totalValueUsd: number }[] = [];
    for (let i = 0; i < data.length; i += 7) {
      const chunk = data.slice(i, i + 7);
      const avgValue =
        chunk.reduce((sum, s) => sum + s.totalValueUsd, 0) / chunk.length;
      result.push({
        timestamp: chunk[Math.floor(chunk.length / 2)].timestamp,
        totalValueUsd: avgValue,
      });
    }
    return result;
  }

  private buildChartResponse(
    data: { timestamp: Date; totalValueUsd: number }[],
    timeframe: string,
  ): ChartDataResponseDto {
    if (data.length === 0) {
      return {
        labels: [],
        data: [],
        changeUsd: 0,
        changePercent: 0,
        timeframe,
      };
    }

    const labels = data.map((d) => d.timestamp.toISOString());
    const values = data.map((d) => d.totalValueUsd);

    const firstValue = values[0] || 0;
    const lastValue = values[values.length - 1] || 0;
    const changeUsd = lastValue - firstValue;
    const changePercent = firstValue > 0 ? (changeUsd / firstValue) * 100 : 0;

    return {
      labels,
      data: values,
      changeUsd,
      changePercent,
      timeframe,
    };
  }

  private toResponse(snapshot: DailySnapshotDocument): SnapshotResponseDto {
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
}
