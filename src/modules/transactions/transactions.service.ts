import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, FilterQuery } from 'mongoose';
import { Transaction, TransactionDocument } from './schemas/transaction.schema';
import { ExchangeCredentialsService } from '../exchange-credentials/exchange-credentials.service';
import { ExchangeFactoryService } from '../../integrations/exchanges/exchange-factory.service';
import { PricesService } from '../prices/prices.service';
import { PnlService } from '../pnl/pnl.service';
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
        query.asset = { $in: assetsArray };
      }
    } else if (filter.asset) {
      query.asset = filter.asset;
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

  async getStats(userId: string): Promise<TransactionStatsDto> {
    const transactions = await this.transactionModel.find({
      userId: new Types.ObjectId(userId),
    });

    const byType: Record<string, number> = {};
    const byExchange: Record<string, number> = {};
    const byAsset: Record<string, number> = {};
    const interestByAsset: Record<string, number> = {};

    for (const tx of transactions) {
      byType[tx.type] = (byType[tx.type] || 0) + 1;
      byExchange[tx.exchange] = (byExchange[tx.exchange] || 0) + 1;
      byAsset[tx.asset] = (byAsset[tx.asset] || 0) + 1;

      // Accumulate interest amounts by asset
      if (tx.type === TransactionType.INTEREST) {
        interestByAsset[tx.asset] = (interestByAsset[tx.asset] || 0) + tx.amount;
      }
    }

    // Calculate total interest in USD
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

    let newTransactions = 0;

    try {
      const [deposits, withdrawals, trades] = await Promise.all([
        adapter.fetchDeposits(since),
        adapter.fetchWithdrawals(since),
        adapter.fetchTrades(since),
      ]);

      this.logger.log(
        `Fetched from ${credential.exchange}: ${deposits.length} deposits, ${withdrawals.length} withdrawals, ${trades.length} trades`,
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
}
