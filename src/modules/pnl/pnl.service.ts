import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as ExcelJS from 'exceljs';
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
      // Get price - use transaction price if available, otherwise fetch historical
      let pricePerUnit = tx.price;
      if (!pricePerUnit || pricePerUnit === 0) {
        pricePerUnit = await this.getHistoricalPriceForTransaction(tx.asset, tx.timestamp);
      }

      await this.addLot(
        userId,
        tx.asset,
        tx.amount,
        pricePerUnit,
        tx.timestamp,
        tx._id.toString(),
        tx.exchange,
        tx.type,
      );
    } else if (this.isDisposal(tx)) {
      // Get price - use transaction price if available, otherwise fetch historical
      let pricePerUnit = tx.price;
      if (!pricePerUnit || pricePerUnit === 0) {
        pricePerUnit = await this.getHistoricalPriceForTransaction(tx.asset, tx.timestamp);
      }

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
   * Get historical price for an asset at a specific date
   * Uses cached prices when available, falls back to API
   */
  private async getHistoricalPriceForTransaction(
    asset: string,
    date: Date,
  ): Promise<number> {
    try {
      const pricesMap = await this.pricesService.getHistoricalPricesMap([asset], date);
      const price = pricesMap[asset] || 0;

      if (price > 0) {
        this.logger.debug(
          `Historical price for ${asset} on ${date.toISOString().split('T')[0]}: $${price}`,
        );
      } else {
        this.logger.warn(
          `Could not find historical price for ${asset} on ${date.toISOString().split('T')[0]}`,
        );
      }

      return price;
    } catch (error) {
      this.logger.warn(
        `Error fetching historical price for ${asset}: ${error.message}`,
      );
      return 0;
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

  /**
   * Export P&L data to Excel for verification
   */
  async exportToExcel(userId: string): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Exchange Monitor';
    workbook.created = new Date();

    // Sheet 1: Cost Basis Lots (Acquisitions)
    const lotsSheet = workbook.addWorksheet('Cost Basis Lots');
    lotsSheet.columns = [
      { header: 'Asset', key: 'asset', width: 12 },
      { header: 'Exchange', key: 'exchange', width: 15 },
      { header: 'Source', key: 'source', width: 12 },
      { header: 'Acquired At', key: 'acquiredAt', width: 20 },
      { header: 'Original Amount', key: 'originalAmount', width: 18 },
      { header: 'Remaining Amount', key: 'remainingAmount', width: 18 },
      { header: 'Cost Per Unit (USD)', key: 'costPerUnit', width: 20 },
      { header: 'Total Cost Basis (USD)', key: 'totalCost', width: 22 },
    ];

    // Style header row
    lotsSheet.getRow(1).font = { bold: true };
    lotsSheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF4472C4' },
    };
    lotsSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

    const lots = await this.costBasisLotModel
      .find({ userId: new Types.ObjectId(userId) })
      .sort({ acquiredAt: 1 });

    for (const lot of lots) {
      lotsSheet.addRow({
        asset: lot.asset,
        exchange: lot.exchange,
        source: lot.source,
        acquiredAt: lot.acquiredAt.toISOString(),
        originalAmount: lot.originalAmount,
        remainingAmount: lot.remainingAmount,
        costPerUnit: lot.costPerUnit,
        totalCost: lot.originalAmount * lot.costPerUnit,
      });
    }

    // Sheet 2: Realized P&L (Disposals)
    const realizedSheet = workbook.addWorksheet('Realized P&L');
    realizedSheet.columns = [
      { header: 'Asset', key: 'asset', width: 12 },
      { header: 'Exchange', key: 'exchange', width: 15 },
      { header: 'Realized At', key: 'realizedAt', width: 20 },
      { header: 'Amount Sold', key: 'amount', width: 15 },
      { header: 'Proceeds (USD)', key: 'proceeds', width: 18 },
      { header: 'Cost Basis (USD)', key: 'costBasis', width: 18 },
      { header: 'Realized P&L (USD)', key: 'realizedPnl', width: 20 },
      { header: 'Holding Period', key: 'holdingPeriod', width: 15 },
      { header: 'Lots Used', key: 'lotsUsed', width: 50 },
    ];

    realizedSheet.getRow(1).font = { bold: true };
    realizedSheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF70AD47' },
    };
    realizedSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

    const realizedRecords = await this.realizedPnlModel
      .find({ userId: new Types.ObjectId(userId) })
      .sort({ realizedAt: 1 });

    for (const record of realizedRecords) {
      const lotsInfo = record.lotBreakdown
        .map(
          (lb) =>
            `${lb.amount.toFixed(8)} @ $${lb.costPerUnit.toFixed(2)} (${new Date(lb.acquiredAt).toLocaleDateString()})`,
        )
        .join('; ');

      const row = realizedSheet.addRow({
        asset: record.asset,
        exchange: record.exchange,
        realizedAt: record.realizedAt.toISOString(),
        amount: record.amount,
        proceeds: record.proceeds,
        costBasis: record.costBasis,
        realizedPnl: record.realizedPnl,
        holdingPeriod: record.holdingPeriod,
        lotsUsed: lotsInfo,
      });

      // Color P&L cell based on positive/negative
      const pnlCell = row.getCell('realizedPnl');
      if (record.realizedPnl >= 0) {
        pnlCell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFC6EFCE' },
        };
        pnlCell.font = { color: { argb: 'FF006100' } };
      } else {
        pnlCell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFFC7CE' },
        };
        pnlCell.font = { color: { argb: 'FF9C0006' } };
      }
    }

    // Sheet 3: Summary by Asset
    const summarySheet = workbook.addWorksheet('Summary by Asset');
    summarySheet.columns = [
      { header: 'Asset', key: 'asset', width: 12 },
      { header: 'Total Acquired', key: 'totalAcquired', width: 18 },
      { header: 'Total Cost Basis (USD)', key: 'totalCostBasis', width: 22 },
      { header: 'Total Sold', key: 'totalSold', width: 18 },
      { header: 'Total Proceeds (USD)', key: 'totalProceeds', width: 22 },
      { header: 'Realized P&L (USD)', key: 'realizedPnl', width: 20 },
      { header: 'Remaining Holdings', key: 'remaining', width: 18 },
      { header: 'Remaining Cost Basis (USD)', key: 'remainingCostBasis', width: 25 },
    ];

    summarySheet.getRow(1).font = { bold: true };
    summarySheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFFFC000' },
    };
    summarySheet.getRow(1).font = { bold: true, color: { argb: 'FF000000' } };

    // Aggregate data by asset
    const assetSummary = new Map<
      string,
      {
        totalAcquired: number;
        totalCostBasis: number;
        totalSold: number;
        totalProceeds: number;
        realizedPnl: number;
        remaining: number;
        remainingCostBasis: number;
      }
    >();

    for (const lot of lots) {
      const existing = assetSummary.get(lot.asset) || {
        totalAcquired: 0,
        totalCostBasis: 0,
        totalSold: 0,
        totalProceeds: 0,
        realizedPnl: 0,
        remaining: 0,
        remainingCostBasis: 0,
      };
      existing.totalAcquired += lot.originalAmount;
      existing.totalCostBasis += lot.originalAmount * lot.costPerUnit;
      existing.remaining += lot.remainingAmount;
      existing.remainingCostBasis += lot.remainingAmount * lot.costPerUnit;
      assetSummary.set(lot.asset, existing);
    }

    for (const record of realizedRecords) {
      const existing = assetSummary.get(record.asset) || {
        totalAcquired: 0,
        totalCostBasis: 0,
        totalSold: 0,
        totalProceeds: 0,
        realizedPnl: 0,
        remaining: 0,
        remainingCostBasis: 0,
      };
      existing.totalSold += record.amount;
      existing.totalProceeds += record.proceeds;
      existing.realizedPnl += record.realizedPnl;
      assetSummary.set(record.asset, existing);
    }

    for (const [asset, data] of assetSummary.entries()) {
      const row = summarySheet.addRow({
        asset,
        totalAcquired: data.totalAcquired,
        totalCostBasis: data.totalCostBasis,
        totalSold: data.totalSold,
        totalProceeds: data.totalProceeds,
        realizedPnl: data.realizedPnl,
        remaining: data.remaining,
        remainingCostBasis: data.remainingCostBasis,
      });

      // Color P&L cell
      const pnlCell = row.getCell('realizedPnl');
      if (data.realizedPnl >= 0) {
        pnlCell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFC6EFCE' },
        };
        pnlCell.font = { color: { argb: 'FF006100' } };
      } else {
        pnlCell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFFC7CE' },
        };
        pnlCell.font = { color: { argb: 'FF9C0006' } };
      }
    }

    // Add totals row
    const totalRealizedPnl = Array.from(assetSummary.values()).reduce(
      (sum, d) => sum + d.realizedPnl,
      0,
    );
    const totalCostBasis = Array.from(assetSummary.values()).reduce(
      (sum, d) => sum + d.totalCostBasis,
      0,
    );
    const totalProceeds = Array.from(assetSummary.values()).reduce(
      (sum, d) => sum + d.totalProceeds,
      0,
    );

    const totalsRow = summarySheet.addRow({
      asset: 'TOTAL',
      totalAcquired: '',
      totalCostBasis,
      totalSold: '',
      totalProceeds,
      realizedPnl: totalRealizedPnl,
      remaining: '',
      remainingCostBasis: Array.from(assetSummary.values()).reduce(
        (sum, d) => sum + d.remainingCostBasis,
        0,
      ),
    });
    totalsRow.font = { bold: true };
    totalsRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE2EFDA' },
    };

    // Generate buffer
    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
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
