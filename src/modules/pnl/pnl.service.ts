import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  CostBasisLot,
  CostBasisLotDocument,
} from './schemas/cost-basis-lot.schema';
import {
  RealizedPnl,
  RealizedPnlDocument,
  LotBreakdown,
} from './schemas/realized-pnl.schema';
import { PricesService } from '../prices/prices.service';
import {
  PnlSummaryResponseDto,
  UnrealizedPnlResponseDto,
  RealizedPnlItemDto,
} from './dto/pnl-response.dto';
import { TransactionDocument } from '../transactions/schemas/transaction.schema';
import { TransactionType } from '../../common/constants/transaction-types.constant';
import { TransactionsService } from '../transactions/transactions.service';

@Injectable()
export class PnlService {
  private readonly logger = new Logger(PnlService.name);

  constructor(
    @InjectModel(CostBasisLot.name)
    private costBasisLotModel: Model<CostBasisLotDocument>,
    @InjectModel(RealizedPnl.name)
    private realizedPnlModel: Model<RealizedPnlDocument>,
    private readonly pricesService: PricesService,
    @Inject(forwardRef(() => TransactionsService))
    private readonly transactionsService: TransactionsService,
  ) {}

  /**
   * Process a transaction and update cost basis / realized P&L
   */
  async processTransaction(tx: TransactionDocument): Promise<void> {
    const userId = tx.userId.toString();

    // Determine if this adds to cost basis or realizes gains
    if (this.isAcquisition(tx)) {
      await this.addLot(
        userId,
        tx.asset,
        tx.amount,
        tx.price || 0,
        tx.timestamp,
        tx._id.toString(),
        tx.exchange,
        tx.type,
      );
    } else if (this.isDisposal(tx)) {
      const pricePerUnit = tx.price || 0;
      await this.consumeLotsFIFO(
        userId,
        tx.asset,
        tx.amount,
        pricePerUnit,
        tx.timestamp,
        tx._id.toString(),
        tx.exchange,
      );
    }
  }

  /**
   * Get P&L summary for a user
   */
  async getSummary(userId: string): Promise<PnlSummaryResponseDto> {
    // Get all realized P&L
    const realizedPnls = await this.realizedPnlModel.find({
      userId: new Types.ObjectId(userId),
    });

    const totalRealizedPnl = realizedPnls.reduce(
      (sum, r) => sum + r.realizedPnl,
      0,
    );

    // Get unrealized P&L
    const unrealized = await this.getUnrealizedPnl(userId);
    const totalUnrealizedPnl = unrealized.totalUnrealizedPnl;

    // Calculate period breakdown
    const now = new Date();
    const startOfDay = new Date(now.setHours(0, 0, 0, 0));
    const startOfWeek = new Date(now);
    startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfYear = new Date(now.getFullYear(), 0, 1);

    const periodBreakdown = {
      today: this.sumRealizedAfter(realizedPnls, startOfDay),
      thisWeek: this.sumRealizedAfter(realizedPnls, startOfWeek),
      thisMonth: this.sumRealizedAfter(realizedPnls, startOfMonth),
      thisYear: this.sumRealizedAfter(realizedPnls, startOfYear),
      allTime: totalRealizedPnl,
    };

    // Group by asset
    const assetMap = new Map<
      string,
      { realized: number; costBasis: number; amount: number }
    >();

    for (const r of realizedPnls) {
      const existing = assetMap.get(r.asset) || {
        realized: 0,
        costBasis: 0,
        amount: 0,
      };
      existing.realized += r.realizedPnl;
      assetMap.set(r.asset, existing);
    }

    // Add unrealized positions
    for (const pos of unrealized.positions) {
      const existing = assetMap.get(pos.asset) || {
        realized: 0,
        costBasis: 0,
        amount: 0,
      };
      existing.costBasis = pos.costBasis;
      existing.amount = pos.amount;
      assetMap.set(pos.asset, existing);
    }

    const byAsset = Array.from(assetMap.entries()).map(([asset, data]) => {
      const unrealizedPos = unrealized.positions.find((p) => p.asset === asset);
      return {
        asset,
        realizedPnl: data.realized,
        unrealizedPnl: unrealizedPos?.unrealizedPnl || 0,
        totalCostBasis: data.costBasis,
        currentValue: unrealizedPos?.currentValue || 0,
        totalAmount: data.amount,
      };
    });

    return {
      totalRealizedPnl,
      totalUnrealizedPnl,
      totalPnl: totalRealizedPnl + totalUnrealizedPnl,
      byAsset,
      periodBreakdown,
    };
  }

  /**
   * Get unrealized P&L based on current holdings
   */
  async getUnrealizedPnl(userId: string): Promise<UnrealizedPnlResponseDto> {
    // Get remaining lots grouped by asset
    const lots = await this.costBasisLotModel.find({
      userId: new Types.ObjectId(userId),
      remainingAmount: { $gt: 0 },
    });

    // Group by asset
    const assetLots = new Map<
      string,
      { amount: number; costBasis: number }
    >();

    for (const lot of lots) {
      const existing = assetLots.get(lot.asset) || { amount: 0, costBasis: 0 };
      existing.amount += lot.remainingAmount;
      existing.costBasis += lot.remainingAmount * lot.costPerUnit;
      assetLots.set(lot.asset, existing);
    }

    // Get current prices
    const assets = Array.from(assetLots.keys());
    const pricesMap = await this.pricesService.getPricesMap(assets);

    const positions = Array.from(assetLots.entries()).map(([asset, data]) => {
      const currentPrice = pricesMap[asset] || 0;
      const currentValue = data.amount * currentPrice;
      const unrealizedPnl = currentValue - data.costBasis;
      const unrealizedPnlPercent =
        data.costBasis > 0 ? (unrealizedPnl / data.costBasis) * 100 : 0;

      return {
        asset,
        amount: data.amount,
        costBasis: data.costBasis,
        currentValue,
        unrealizedPnl,
        unrealizedPnlPercent,
      };
    });

    const totalUnrealizedPnl = positions.reduce(
      (sum, p) => sum + p.unrealizedPnl,
      0,
    );

    return {
      totalUnrealizedPnl,
      positions,
    };
  }

  /**
   * Get realized P&L history
   */
  async getRealizedPnl(
    userId: string,
    startDate?: Date,
    endDate?: Date,
  ): Promise<RealizedPnlItemDto[]> {
    const query: Record<string, unknown> = {
      userId: new Types.ObjectId(userId),
    };

    if (startDate || endDate) {
      query.realizedAt = {};
      if (startDate) {
        (query.realizedAt as Record<string, Date>).$gte = startDate;
      }
      if (endDate) {
        (query.realizedAt as Record<string, Date>).$lte = endDate;
      }
    }

    const records = await this.realizedPnlModel
      .find(query)
      .sort({ realizedAt: -1 });

    return records.map((r) => ({
      id: r._id.toString(),
      asset: r.asset,
      amount: r.amount,
      proceeds: r.proceeds,
      costBasis: r.costBasis,
      realizedPnl: r.realizedPnl,
      realizedAt: r.realizedAt,
      exchange: r.exchange,
    }));
  }

  /**
   * Recalculate all P&L from transaction history
   */
  async recalculateAll(userId: string): Promise<{ processed: number }> {
    this.logger.log(`Starting P&L recalculation for user ${userId}`);

    // Clear existing data
    await this.costBasisLotModel.deleteMany({
      userId: new Types.ObjectId(userId),
    });
    await this.realizedPnlModel.deleteMany({
      userId: new Types.ObjectId(userId),
    });

    // Get all transactions sorted by timestamp
    const transactions = await this.transactionsService.findAllByUserSorted(userId);

    this.logger.log(`Processing ${transactions.length} transactions for P&L recalculation`);

    let processed = 0;
    for (const tx of transactions) {
      try {
        await this.processTransaction(tx);
        processed++;
      } catch (error) {
        this.logger.warn(`Failed to process transaction ${tx._id}: ${error.message}`);
      }
    }

    this.logger.log(`P&L recalculation complete. Processed ${processed}/${transactions.length} transactions`);

    return { processed };
  }

  // ==================== PRIVATE METHODS ====================

  private isAcquisition(tx: TransactionDocument): boolean {
    return (
      tx.type === TransactionType.DEPOSIT ||
      tx.type === TransactionType.INTEREST ||
      (tx.type === TransactionType.TRADE && tx.side === 'buy')
    );
  }

  private isDisposal(tx: TransactionDocument): boolean {
    return (
      tx.type === TransactionType.WITHDRAWAL ||
      (tx.type === TransactionType.TRADE && tx.side === 'sell')
    );
  }

  private async addLot(
    userId: string,
    asset: string,
    amount: number,
    costPerUnit: number,
    acquiredAt: Date,
    transactionId: string,
    exchange: string,
    source: string,
  ): Promise<CostBasisLotDocument> {
    const lot = new this.costBasisLotModel({
      userId: new Types.ObjectId(userId),
      asset,
      originalAmount: amount,
      remainingAmount: amount,
      costPerUnit,
      acquiredAt,
      transactionId: new Types.ObjectId(transactionId),
      exchange,
      source,
    });

    this.logger.debug(
      `Added lot: ${amount} ${asset} @ $${costPerUnit} (${source})`,
    );

    return lot.save();
  }

  private async consumeLotsFIFO(
    userId: string,
    asset: string,
    amount: number,
    proceedsPerUnit: number,
    realizedAt: Date,
    transactionId: string,
    exchange: string,
  ): Promise<void> {
    // Get oldest lots first (FIFO)
    const lots = await this.costBasisLotModel
      .find({
        userId: new Types.ObjectId(userId),
        asset,
        remainingAmount: { $gt: 0 },
      })
      .sort({ acquiredAt: 1 });

    let remainingToSell = amount;
    let totalCostBasis = 0;
    const lotBreakdown: LotBreakdown[] = [];

    for (const lot of lots) {
      if (remainingToSell <= 0) break;

      const consumeAmount = Math.min(lot.remainingAmount, remainingToSell);
      totalCostBasis += consumeAmount * lot.costPerUnit;

      lotBreakdown.push({
        lotId: lot._id,
        amount: consumeAmount,
        costPerUnit: lot.costPerUnit,
        acquiredAt: lot.acquiredAt,
      });

      // Update lot
      lot.remainingAmount -= consumeAmount;
      await lot.save();

      remainingToSell -= consumeAmount;

      this.logger.debug(
        `Consumed ${consumeAmount} from lot acquired at ${lot.acquiredAt}`,
      );
    }

    if (remainingToSell > 0) {
      this.logger.warn(
        `Not enough lots to cover sale of ${amount} ${asset}. Missing: ${remainingToSell}`,
      );
    }

    const actualSold = amount - remainingToSell;
    const proceeds = actualSold * proceedsPerUnit;
    const realizedPnl = proceeds - totalCostBasis;

    // Determine holding period (>1 year = long term)
    const oldestLot = lotBreakdown[0];
    const holdingPeriod =
      oldestLot &&
      realizedAt.getTime() - new Date(oldestLot.acquiredAt).getTime() >
        365 * 24 * 60 * 60 * 1000
        ? 'long_term'
        : 'short_term';

    // Create realized P&L record
    const realizedRecord = new this.realizedPnlModel({
      userId: new Types.ObjectId(userId),
      transactionId: new Types.ObjectId(transactionId),
      asset,
      amount: actualSold,
      proceeds,
      costBasis: totalCostBasis,
      realizedPnl,
      realizedAt,
      holdingPeriod,
      lotBreakdown,
      exchange,
    });

    await realizedRecord.save();

    this.logger.debug(
      `Realized P&L: ${realizedPnl.toFixed(2)} USD from ${actualSold} ${asset}`,
    );
  }

  private sumRealizedAfter(
    records: RealizedPnlDocument[],
    since: Date,
  ): number {
    return records
      .filter((r) => r.realizedAt >= since)
      .reduce((sum, r) => sum + r.realizedPnl, 0);
  }
}
