import { Injectable, Logger, NotFoundException, Inject, forwardRef } from '@nestjs/common';
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
import { TransactionsService } from '../transactions/transactions.service';
import { TransactionDocument } from '../transactions/schemas/transaction.schema';
import { TransactionType } from '../../common/constants/transaction-types.constant';
import {
  SnapshotResponseDto,
  SnapshotCompareDto,
  ChartDataResponseDto,
  ChartDataByAssetResponseDto,
  AssetChartDataDto,
  RebuildHistoryResponseDto,
} from './dto/snapshot-response.dto';

@Injectable()
export class SnapshotsService {
  private readonly logger = new Logger(SnapshotsService.name);

  // DEMO: Factor to divide all values (set to 1 for real values)
  private readonly DEMO_FACTOR: number = 10;

  constructor(
    @InjectModel(DailySnapshot.name)
    private snapshotModel: Model<DailySnapshotDocument>,
    @InjectModel(HourlySnapshot.name)
    private hourlySnapshotModel: Model<HourlySnapshotDocument>,
    private readonly balancesService: BalancesService,
    private readonly pricesService: PricesService,
    @Inject(forwardRef(() => TransactionsService))
    private readonly transactionsService: TransactionsService,
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

    // Get current balance (already has DEMO_FACTOR applied from balancesService)
    const current = await this.balancesService.getConsolidatedBalances(userId);
    const currentValue = current.totalValueUsd;
    // DEMO: Apply factor to snapshot value
    const value24hAgo = (snapshot?.totalValueUsd || currentValue * this.DEMO_FACTOR) / this.DEMO_FACTOR;

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

    const rawSnapshots = await this.hourlySnapshotModel
      .find({
        userId: new Types.ObjectId(userId),
        timestamp: { $gte: since },
      })
      .sort({ timestamp: 1 });

    // Collect all available assets from snapshots (before aggregation)
    const allAssets = new Set<string>();
    rawSnapshots.forEach((s) => {
      s.assetBalances?.forEach((ab) => allAssets.add(ab.asset));
    });

    const availableAssets = Array.from(allAssets).sort();
    const filteredAssets =
      assets && assets.length > 0 ? assets : availableAssets;

    // Show all hourly data points for better granularity
    const snapshots = rawSnapshots.map((s) => ({
      timestamp: s.timestamp,
      totalValueUsd: s.totalValueUsd,
      assetBalances: s.assetBalances,
    }));

    // Build data per asset - DEMO: Apply factor
    const assetData: AssetChartDataDto[] = filteredAssets.map((asset) => ({
      asset,
      data: snapshots.map((s) => {
        const ab = s.assetBalances?.find((a) => a.asset === asset);
        return (ab?.valueUsd || 0) / this.DEMO_FACTOR;
      }),
    }));

    // Build total data and calculate change - DEMO: Apply factor
    const totalData = snapshots.map((s) => s.totalValueUsd / this.DEMO_FACTOR);
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

    // Show all hourly data points for better granularity
    const data = snapshots.map((s) => ({
      timestamp: s.timestamp,
      totalValueUsd: s.totalValueUsd,
    }));

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
    // DEMO: Apply factor to values
    const values = data.map((d) => d.totalValueUsd / this.DEMO_FACTOR);

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

  // ==================== REBUILD HISTORY ====================

  /**
   * Rebuild historical balance snapshots from transactions
   * This method recalculates the balance at each day based on transaction history
   */
  async rebuildHistory(
    userId: string,
    options?: {
      fromDate?: string;
      skipExisting?: boolean;
    },
  ): Promise<RebuildHistoryResponseDto> {
    const userIdObj = new Types.ObjectId(userId);
    this.logger.log(`[RebuildHistory] Starting for user ${userId}`);

    // Get all transactions sorted by timestamp
    const transactions = await this.transactionsService.findAllByUserSorted(userId);

    if (transactions.length === 0) {
      this.logger.log(`[RebuildHistory] No transactions found for user`);
      return {
        success: true,
        message: 'No transactions found',
        daysProcessed: 0,
        snapshotsCreated: 0,
        snapshotsUpdated: 0,
      };
    }

    // Determine date range
    const firstTxDate = new Date(transactions[0].timestamp);
    const startDate = options?.fromDate
      ? new Date(options.fromDate)
      : firstTxDate;
    const endDate = new Date();

    // Set to start of day
    startDate.setUTCHours(0, 0, 0, 0);
    endDate.setUTCHours(23, 59, 59, 999);

    this.logger.log(
      `[RebuildHistory] Processing from ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`,
    );

    // Get existing snapshots if we want to skip them
    const existingDates = new Set<string>();
    if (options?.skipExisting) {
      const existing = await this.snapshotModel.find({
        userId: userIdObj,
        date: {
          $gte: startDate.toISOString().split('T')[0],
          $lte: endDate.toISOString().split('T')[0],
        },
      });
      for (const snapshot of existing) {
        existingDates.add(snapshot.date);
      }
      this.logger.log(`[RebuildHistory] Found ${existingDates.size} existing snapshots to skip`);
    }

    // Build a running balance from transactions
    const balanceState = new Map<string, number>(); // asset -> amount
    let txIndex = 0;

    let daysProcessed = 0;
    let snapshotsCreated = 0;
    let snapshotsUpdated = 0;

    // Collect all unique assets for price fetching
    const allAssets = new Set<string>();
    for (const tx of transactions) {
      allAssets.add(tx.asset);
      if (tx.feeAsset) allAssets.add(tx.feeAsset);
    }

    // Process day by day
    const currentDate = new Date(startDate);
    while (currentDate <= endDate) {
      const dateStr = currentDate.toISOString().split('T')[0];
      const dayEnd = new Date(currentDate);
      dayEnd.setUTCHours(23, 59, 59, 999);

      // Skip if we already have a snapshot and skipExisting is true
      if (options?.skipExisting && existingDates.has(dateStr)) {
        // Still need to process transactions to update balance state
        while (
          txIndex < transactions.length &&
          new Date(transactions[txIndex].timestamp) <= dayEnd
        ) {
          this.applyTransaction(balanceState, transactions[txIndex]);
          txIndex++;
        }
        currentDate.setDate(currentDate.getDate() + 1);
        continue;
      }

      // Process all transactions up to end of this day
      while (
        txIndex < transactions.length &&
        new Date(transactions[txIndex].timestamp) <= dayEnd
      ) {
        this.applyTransaction(balanceState, transactions[txIndex]);
        txIndex++;
      }

      // Get assets with non-zero balances
      const assetsWithBalance = Array.from(balanceState.entries())
        .filter(([_, amount]) => amount > 0.00000001)
        .map(([asset]) => asset);

      if (assetsWithBalance.length === 0) {
        currentDate.setDate(currentDate.getDate() + 1);
        daysProcessed++;
        continue;
      }

      // Get historical prices for this date
      const pricesMap = await this.pricesService.getHistoricalPricesMap(
        assetsWithBalance,
        currentDate,
      );

      // Build consolidated balances
      const consolidatedBalances: AssetBalance[] = [];
      let totalValueUsd = 0;

      for (const asset of assetsWithBalance) {
        const amount = balanceState.get(asset) || 0;
        const priceUsd = pricesMap[asset] || 0;
        const valueUsd = amount * priceUsd;

        consolidatedBalances.push({
          asset,
          amount,
          priceUsd,
          valueUsd,
        });

        totalValueUsd += valueUsd;
      }

      // Sort by value descending
      consolidatedBalances.sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0));

      // Check if snapshot exists
      const existing = await this.snapshotModel.findOne({
        userId: userIdObj,
        date: dateStr,
      });

      const snapshotData = {
        userId: userIdObj,
        date: dateStr,
        snapshotAt: dayEnd,
        exchangeBalances: [], // We don't have per-exchange breakdown from transactions
        consolidatedBalances,
        totalValueUsd,
        pricesAtSnapshot: pricesMap,
      };

      if (existing) {
        Object.assign(existing, snapshotData);
        await existing.save();
        snapshotsUpdated++;
      } else {
        await this.snapshotModel.create(snapshotData);
        snapshotsCreated++;
      }

      daysProcessed++;

      // Log progress every 30 days
      if (daysProcessed % 30 === 0) {
        this.logger.log(
          `[RebuildHistory] Progress: ${daysProcessed} days processed, ${snapshotsCreated} created, ${snapshotsUpdated} updated`,
        );
      }

      currentDate.setDate(currentDate.getDate() + 1);
    }

    this.logger.log(
      `[RebuildHistory] Completed: ${daysProcessed} days processed, ${snapshotsCreated} created, ${snapshotsUpdated} updated`,
    );

    return {
      success: true,
      message: 'History rebuilt successfully',
      daysProcessed,
      snapshotsCreated,
      snapshotsUpdated,
    };
  }

  /**
   * Apply a transaction to the balance state
   */
  private applyTransaction(
    balanceState: Map<string, number>,
    tx: TransactionDocument,
  ): void {
    const currentBalance = balanceState.get(tx.asset) || 0;

    switch (tx.type) {
      case TransactionType.DEPOSIT:
      case TransactionType.INTEREST:
        // Add to balance
        balanceState.set(tx.asset, currentBalance + tx.amount);
        break;

      case TransactionType.WITHDRAWAL:
      case TransactionType.FEE:
        // Subtract from balance
        balanceState.set(tx.asset, currentBalance - Math.abs(tx.amount));
        break;

      case TransactionType.TRADE:
        // For trades, we need to handle both sides
        // amount is typically the base asset amount
        // If side is 'buy', we receive the asset
        // If side is 'sell', we lose the asset
        if (tx.side === 'buy') {
          balanceState.set(tx.asset, currentBalance + Math.abs(tx.amount));
          // Subtract the quote asset (price * amount)
          if (tx.priceAsset && tx.price) {
            const quoteBalance = balanceState.get(tx.priceAsset) || 0;
            balanceState.set(
              tx.priceAsset,
              quoteBalance - Math.abs(tx.amount * tx.price),
            );
          }
        } else if (tx.side === 'sell') {
          balanceState.set(tx.asset, currentBalance - Math.abs(tx.amount));
          // Add the quote asset
          if (tx.priceAsset && tx.price) {
            const quoteBalance = balanceState.get(tx.priceAsset) || 0;
            balanceState.set(
              tx.priceAsset,
              quoteBalance + Math.abs(tx.amount * tx.price),
            );
          }
        }
        break;

      case TransactionType.TRANSFER:
        // Transfers might be in or out, check if amount is positive or negative
        balanceState.set(tx.asset, currentBalance + tx.amount);
        break;
    }

    // Apply fee if present
    if (tx.fee && tx.feeAsset) {
      const feeBalance = balanceState.get(tx.feeAsset) || 0;
      balanceState.set(tx.feeAsset, feeBalance - Math.abs(tx.fee));
    }
  }
}
