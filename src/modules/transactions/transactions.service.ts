import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, FilterQuery } from 'mongoose';
import * as ExcelJS from 'exceljs';
import { Transaction, TransactionDocument } from './schemas/transaction.schema';
import { ExchangeCredentialsService } from '../exchange-credentials/exchange-credentials.service';
import { ExchangeFactoryService } from '../../integrations/exchanges/exchange-factory.service';
import { PricesService } from '../prices/prices.service';
import { PnlService } from '../pnl/pnl.service';
import { SettingsService } from '../settings/settings.service';
import { ExchangeType } from '../../common/constants/exchanges.constant';
import { TransactionType } from '../../common/constants/transaction-types.constant';
import { TransactionFilterDto } from './dto/transaction-filter.dto';
import {
  PaginatedTransactionsDto,
  TransactionStatsDto,
} from './dto/transaction-response.dto';
import { ITransaction } from '../../common/interfaces/exchange-adapter.interface';

@Injectable()
export class TransactionsService {
  private readonly logger = new Logger(TransactionsService.name);

  constructor(
    @InjectModel(Transaction.name)
    private transactionModel: Model<TransactionDocument>,
    private readonly credentialsService: ExchangeCredentialsService,
    private readonly exchangeFactory: ExchangeFactoryService,
    private readonly pricesService: PricesService,
    @Inject(forwardRef(() => PnlService))
    private readonly pnlService: PnlService,
    private readonly settingsService: SettingsService,
  ) {}

  async findAll(
    userId: string,
    filter: TransactionFilterDto,
  ): Promise<PaginatedTransactionsDto> {
    const query: FilterQuery<Transaction> = {
      userId: new Types.ObjectId(userId),
    };

    if (filter.exchange) {
      query.exchange = filter.exchange;
    }
    if (filter.types) {
      const typesArray = filter.types.split(',').filter(t => t.trim());
      if (typesArray.length > 0) {
        query.type = { $in: typesArray };
      }
    } else if (filter.type) {
      query.type = filter.type;
    }
    if (filter.assets) {
      const assetsArray = filter.assets.split(',').filter(a => a.trim());
      if (assetsArray.length > 0) {
        // Match either the primary asset OR the price asset (for trades)
        query.$or = [
          { asset: { $in: assetsArray } },
          { priceAsset: { $in: assetsArray } },
        ];
      }
    } else if (filter.asset) {
      // Match either the primary asset OR the price asset (for trades)
      query.$or = [
        { asset: filter.asset },
        { priceAsset: filter.asset },
      ];
    }
    if (filter.startDate || filter.endDate) {
      query.timestamp = {};
      if (filter.startDate) {
        query.timestamp.$gte = new Date(filter.startDate);
      }
      if (filter.endDate) {
        query.timestamp.$lte = new Date(filter.endDate);
      }
    }

    const skip = (filter.page - 1) * filter.limit;
    const [transactions, total] = await Promise.all([
      this.transactionModel
        .find(query)
        .sort({ timestamp: -1 })
        .skip(skip)
        .limit(filter.limit),
      this.transactionModel.countDocuments(query),
    ]);

    return {
      data: transactions.map((t) => ({
        id: t._id.toString(),
        exchange: t.exchange,
        externalId: t.externalId,
        type: t.type,
        asset: t.asset,
        amount: t.amount,
        fee: t.fee,
        feeAsset: t.feeAsset,
        price: t.price,
        priceAsset: t.priceAsset,
        pair: t.pair,
        side: t.side,
        timestamp: t.timestamp,
      })),
      total,
      page: filter.page,
      limit: filter.limit,
      totalPages: Math.ceil(total / filter.limit),
    };
  }

  async findById(id: string, userId: string): Promise<TransactionDocument | null> {
    return this.transactionModel.findOne({
      _id: new Types.ObjectId(id),
      userId: new Types.ObjectId(userId),
    });
  }

  async findByCredential(
    credentialId: string,
    userId: string,
  ): Promise<TransactionDocument[]> {
    return this.transactionModel
      .find({
        userId: new Types.ObjectId(userId),
        credentialId: new Types.ObjectId(credentialId),
      })
      .sort({ timestamp: 1 })
      .exec();
  }

  async getStats(
    userId: string,
    filter?: {
      exchange?: string;
      startDate?: string;
      endDate?: string;
      types?: string;
      assets?: string;
    },
  ): Promise<TransactionStatsDto> {
    // Build the main query with all filters
    const query: FilterQuery<Transaction> = {
      userId: new Types.ObjectId(userId),
    };

    // Apply filters
    if (filter?.exchange) {
      query.exchange = filter.exchange;
    }
    if (filter?.types) {
      const typesArray = filter.types.split(',').filter((t) => t.trim());
      if (typesArray.length > 0) {
        query.type = { $in: typesArray };
      }
    }
    if (filter?.assets) {
      const assetsArray = filter.assets.split(',').filter((a) => a.trim());
      if (assetsArray.length > 0) {
        // Match either the primary asset OR the price asset (for trades)
        query.$or = [
          { asset: { $in: assetsArray } },
          { priceAsset: { $in: assetsArray } },
        ];
      }
    }
    if (filter?.startDate || filter?.endDate) {
      query.timestamp = {};
      if (filter.startDate) {
        query.timestamp.$gte = new Date(filter.startDate);
      }
      if (filter.endDate) {
        query.timestamp.$lte = new Date(filter.endDate);
      }
    }

    // Get filtered transactions for stats
    const transactions = await this.transactionModel.find(query);

    const byType: Record<string, number> = {};
    const byExchange: Record<string, number> = {};
    const byAsset: Record<string, number> = {};

    for (const tx of transactions) {
      byType[tx.type] = (byType[tx.type] || 0) + 1;
      byExchange[tx.exchange] = (byExchange[tx.exchange] || 0) + 1;
      byAsset[tx.asset] = (byAsset[tx.asset] || 0) + 1;
      // Also count priceAsset for trades (the received/paid asset)
      if (tx.priceAsset && tx.type === TransactionType.TRADE) {
        byAsset[tx.priceAsset] = (byAsset[tx.priceAsset] || 0) + 1;
      }
    }

    // Calculate interest in USD from filtered transactions
    const interestTransactions = transactions.filter(
      (tx) => tx.type === TransactionType.INTEREST,
    );
    const interestByAsset: Record<string, number> = {};
    for (const tx of interestTransactions) {
      interestByAsset[tx.asset] = (interestByAsset[tx.asset] || 0) + tx.amount;
    }

    let totalInterestUsd = 0;
    const interestAssets = Object.keys(interestByAsset);
    if (interestAssets.length > 0) {
      const pricesMap = await this.pricesService.getPricesMap(interestAssets);
      for (const asset of interestAssets) {
        const price = pricesMap[asset] || 0;
        totalInterestUsd += interestByAsset[asset] * price;
      }
    }

    return {
      totalTransactions: transactions.length,
      byType,
      byExchange,
      byAsset,
      totalInterestUsd,
    };
  }

  async syncFromExchange(
    credentialId: string | Types.ObjectId,
    fullSync = false,
  ): Promise<number> {
    const credential = await this.credentialsService.findById(
      credentialId.toString(),
      null, // Skip user validation for internal use
    );

    if (!credential) {
      this.logger.warn(`Credential not found: ${credentialId}`);
      return 0;
    }

    this.logger.log(
      `Starting ${fullSync ? 'FULL ' : ''}sync for ${credential.exchange} (${credentialId})`,
    );

    const decrypted = this.credentialsService.getDecryptedCredentials(credential);
    const adapter = this.exchangeFactory.createAdapter(
      credential.exchange as ExchangeType,
      decrypted.apiKey,
      decrypted.apiSecret,
      decrypted.passphrase,
    );

    let since: Date | undefined;

    if (!fullSync) {
      const lastTransaction = await this.transactionModel
        .findOne({
          credentialId: credential._id,
        })
        .sort({ timestamp: -1 });

      since = lastTransaction?.timestamp;
    }

    this.logger.log(`Fetching transactions since: ${since ? since.toISOString() : 'beginning of time'}`);

    // Get configured symbols for trade sync (per exchange)
    const symbols = await this.settingsService.getSymbolsForExchange(
      credential.userId.toString(),
      credential.exchange,
    );
    this.logger.log(`Configured symbols for ${credential.exchange}: ${symbols.length > 0 ? symbols.join(', ') : 'none'}`);

    let newTransactions = 0;

    try {
      // Fetch standard transactions
      const fetchPromises: Promise<ITransaction[]>[] = [
        adapter.fetchDeposits(since),
        adapter.fetchWithdrawals(since),
        adapter.fetchTrades(since, undefined, symbols),
      ];

      // Add ledger fetch if supported (for buy/sell/convert operations)
      if (adapter.fetchLedger) {
        fetchPromises.push(adapter.fetchLedger(since, symbols));
      }

      const results = await Promise.all(fetchPromises);
      const deposits = results[0];
      const withdrawals = results[1];
      const trades = results[2];
      const ledgerTrades = results[3] || [];

      this.logger.log(
        `Fetched from ${credential.exchange}: ${deposits.length} deposits, ${withdrawals.length} withdrawals, ${trades.length} trades, ${ledgerTrades.length} ledger trades`,
      );

      // Process deposits
      for (const tx of deposits) {
        try {
          await this.upsertTransaction(
            credential.userId.toString(),
            credential._id.toString(),
            credential.exchange,
            tx,
            TransactionType.DEPOSIT,
          );
          newTransactions++;
        } catch (error) {
          if (!error.message?.includes('duplicate')) {
            this.logger.warn(`Failed to save transaction: ${error.message}`);
          }
        }
      }

      // Process withdrawals
      for (const tx of withdrawals) {
        try {
          await this.upsertTransaction(
            credential.userId.toString(),
            credential._id.toString(),
            credential.exchange,
            tx,
            TransactionType.WITHDRAWAL,
          );
          newTransactions++;
        } catch (error) {
          if (!error.message?.includes('duplicate')) {
            this.logger.warn(`Failed to save transaction: ${error.message}`);
          }
        }
      }

      // Process trades
      for (const tx of trades) {
        try {
          await this.upsertTransaction(
            credential.userId.toString(),
            credential._id.toString(),
            credential.exchange,
            tx,
            TransactionType.TRADE,
          );
          newTransactions++;
        } catch (error) {
          if (!error.message?.includes('duplicate')) {
            this.logger.warn(`Failed to save transaction: ${error.message}`);
          }
        }
      }

      // Process ledger trades (buy/sell/convert from instant purchases)
      for (const tx of ledgerTrades) {
        try {
          await this.upsertTransaction(
            credential.userId.toString(),
            credential._id.toString(),
            credential.exchange,
            tx,
            TransactionType.TRADE,
          );
          newTransactions++;
        } catch (error) {
          if (!error.message?.includes('duplicate')) {
            this.logger.warn(`Failed to save ledger transaction: ${error.message}`);
          }
        }
      }
    } catch (error) {
      this.logger.error(`Sync failed for ${credential.exchange}: ${error.message}`);
    }

    return newTransactions;
  }

  async syncAllForUser(userId: string): Promise<number> {
    const credentials = await this.credentialsService.findActiveByUser(userId);
    let totalSynced = 0;

    for (const credential of credentials) {
      const synced = await this.syncFromExchange(credential._id);
      totalSynced += synced;
    }

    return totalSynced;
  }

  private async upsertTransaction(
    userId: string,
    credentialId: string,
    exchange: string,
    tx: ITransaction,
    type: TransactionType,
  ): Promise<TransactionDocument> {
    // Check if transaction already exists to avoid re-processing P&L
    const existingTx = await this.transactionModel.findOne({
      externalId: tx.externalId,
      exchange,
    });

    const isNewTransaction = !existingTx;

    const savedTx = await this.transactionModel.findOneAndUpdate(
      {
        externalId: tx.externalId,
        exchange,
      },
      {
        userId: new Types.ObjectId(userId),
        credentialId: new Types.ObjectId(credentialId),
        exchange,
        externalId: tx.externalId,
        type,
        asset: tx.asset,
        amount: tx.amount,
        fee: tx.fee,
        feeAsset: tx.feeAsset,
        price: tx.price,
        priceAsset: tx.priceAsset,
        total: tx.price ? tx.amount * tx.price : undefined,
        pair: tx.pair,
        side: tx.side,
        timestamp: tx.timestamp,
        rawData: tx.rawData,
      },
      {
        upsert: true,
        new: true,
      },
    );

    // Process P&L only for new transactions
    if (isNewTransaction && savedTx) {
      try {
        await this.pnlService.processTransaction(savedTx);
      } catch (error) {
        this.logger.warn(`Failed to process P&L for transaction ${savedTx._id}: ${error.message}`);
      }
    }

    return savedTx;
  }

  /**
   * Get all transactions for a user sorted by timestamp (for P&L recalculation)
   */
  async findAllByUserSorted(userId: string): Promise<TransactionDocument[]> {
    return this.transactionModel
      .find({ userId: new Types.ObjectId(userId) })
      .sort({ timestamp: 1 })
      .exec();
  }

  /**
   * Export transactions to Excel with filters
   */
  async exportToExcel(
    userId: string,
    filter: TransactionFilterDto,
  ): Promise<Buffer> {
    // Build query (same as findAll but without pagination)
    const query: FilterQuery<Transaction> = {
      userId: new Types.ObjectId(userId),
    };

    if (filter.exchange) {
      query.exchange = filter.exchange;
    }
    if (filter.types) {
      const typesArray = filter.types.split(',').filter((t) => t.trim());
      if (typesArray.length > 0) {
        query.type = { $in: typesArray };
      }
    } else if (filter.type) {
      query.type = filter.type;
    }
    if (filter.assets) {
      const assetsArray = filter.assets.split(',').filter((a) => a.trim());
      if (assetsArray.length > 0) {
        query.$or = [
          { asset: { $in: assetsArray } },
          { priceAsset: { $in: assetsArray } },
        ];
      }
    } else if (filter.asset) {
      query.$or = [{ asset: filter.asset }, { priceAsset: filter.asset }];
    }
    if (filter.startDate || filter.endDate) {
      query.timestamp = {};
      if (filter.startDate) {
        query.timestamp.$gte = new Date(filter.startDate);
      }
      if (filter.endDate) {
        query.timestamp.$lte = new Date(filter.endDate);
      }
    }

    const transactions = await this.transactionModel
      .find(query)
      .sort({ timestamp: -1 })
      .exec();

    // Create workbook
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Exchange Monitor';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Transacciones');

    // Define columns
    sheet.columns = [
      { header: 'Fecha', key: 'timestamp', width: 20 },
      { header: 'Exchange', key: 'exchange', width: 15 },
      { header: 'Tipo', key: 'type', width: 12 },
      { header: 'Asset', key: 'asset', width: 10 },
      { header: 'Cantidad', key: 'amount', width: 18 },
      { header: 'Asset Recibido', key: 'priceAsset', width: 14 },
      { header: 'Cantidad Recibida', key: 'receivedAmount', width: 18 },
      { header: 'Precio', key: 'price', width: 15 },
      { header: 'Par', key: 'pair', width: 15 },
      { header: 'Lado', key: 'side', width: 10 },
      { header: 'Fee', key: 'fee', width: 15 },
      { header: 'Fee Asset', key: 'feeAsset', width: 10 },
    ];

    // Style header row
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF4472C4' },
    };
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

    // Add data
    for (const tx of transactions) {
      const receivedAmount =
        tx.type === TransactionType.TRADE && tx.price
          ? tx.amount * tx.price
          : null;

      const row = sheet.addRow({
        timestamp: tx.timestamp.toISOString().replace('T', ' ').substring(0, 19),
        exchange: this.getExchangeLabel(tx.exchange),
        type: this.getTypeLabel(tx.type),
        asset: tx.asset,
        amount: tx.amount,
        priceAsset: tx.priceAsset || '-',
        receivedAmount: receivedAmount ?? '-',
        price: tx.price || '-',
        pair: tx.pair || '-',
        side: tx.side ? (tx.side === 'buy' ? 'Compra' : 'Venta') : '-',
        fee: tx.fee || '-',
        feeAsset: tx.feeAsset || '-',
      });

      // Color amount based on type
      const amountCell = row.getCell('amount');
      if (
        tx.type === TransactionType.DEPOSIT ||
        tx.type === TransactionType.INTEREST ||
        tx.side === 'buy'
      ) {
        amountCell.font = { color: { argb: 'FF0ECB81' } };
      } else if (
        tx.type === TransactionType.WITHDRAWAL ||
        tx.type === TransactionType.FEE ||
        tx.side === 'sell'
      ) {
        amountCell.font = { color: { argb: 'FFF6465D' } };
      }
    }

    // Generate buffer
    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  private getExchangeLabel(exchange: string): string {
    const labels: Record<string, string> = {
      binance: 'Binance',
      'binance-futures': 'Binance Futures',
      kraken: 'Kraken',
      'nexo-pro': 'Nexo Pro',
      'nexo-manual': 'Nexo',
    };
    return labels[exchange] || exchange;
  }

  private getTypeLabel(type: string): string {
    const labels: Record<string, string> = {
      deposit: 'Depósito',
      withdrawal: 'Retiro',
      trade: 'Trade',
      interest: 'Interés',
      fee: 'Comisión',
    };
    return labels[type] || type;
  }
}
