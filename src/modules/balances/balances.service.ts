import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ExchangeCredentialsService } from '../exchange-credentials/exchange-credentials.service';
import { ExchangeFactoryService } from '../../integrations/exchanges/exchange-factory.service';
import { PricesService } from '../prices/prices.service';
import { TransactionsService } from '../transactions/transactions.service';
import { IBalance, IExchangeAdapter } from '../../common/interfaces/exchange-adapter.interface';
import { ExchangeType } from '../../common/constants/exchanges.constant';
import { NexoManualTransaction } from '../../integrations/exchanges/nexo-manual/nexo-manual.adapter';
import { BinanceManualTransaction } from '../../integrations/exchanges/binance-manual/binance-manual.adapter';
import {
  AssetBalanceDto,
  ExchangeBalanceDto,
  ConsolidatedBalanceDto,
} from './dto/balance-response.dto';
import {
  CachedBalance,
  CachedBalanceDocument,
  CachedBalanceData,
} from './schemas/cached-balance.schema';

@Injectable()
export class BalancesService {
  private readonly logger = new Logger(BalancesService.name);
  private syncingUsers = new Set<string>(); // Track users currently syncing

  constructor(
    @InjectModel(CachedBalance.name)
    private readonly cachedBalanceModel: Model<CachedBalanceDocument>,
    private readonly credentialsService: ExchangeCredentialsService,
    private readonly exchangeFactory: ExchangeFactoryService,
    private readonly pricesService: PricesService,
    @Inject(forwardRef(() => TransactionsService))
    private readonly transactionsService: TransactionsService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Normalizes asset names to their base counterparts
   * - LDBTC -> BTC (Binance Locked Defi)
   * - LDETH -> ETH
   * etc.
   */
  private normalizeAsset(asset: string): string {
    // Binance Locked Defi products have "LD" prefix
    if (asset.startsWith('LD') && asset.length > 2) {
      return asset.substring(2);
    }
    return asset;
  }

  /**
   * Get cached balance for a user
   */
  async getCachedBalance(userId: string): Promise<CachedBalanceDocument | null> {
    return this.cachedBalanceModel.findOne({
      userId: new Types.ObjectId(userId),
    });
  }

  /**
   * Save balance to cache
   */
  private async updateBalanceCache(
    userId: string,
    data: CachedBalanceData,
  ): Promise<void> {
    await this.cachedBalanceModel.findOneAndUpdate(
      { userId: new Types.ObjectId(userId) },
      {
        userId: new Types.ObjectId(userId),
        data,
        lastSyncAt: new Date(),
        isSyncing: false,
      },
      { upsert: true, new: true },
    );
  }

  /**
   * Mark user as syncing
   */
  private async setSyncingStatus(userId: string, isSyncing: boolean): Promise<void> {
    await this.cachedBalanceModel.findOneAndUpdate(
      { userId: new Types.ObjectId(userId) },
      { isSyncing },
    );
  }

  /**
   * Sync balances in background (does not block)
   */
  async syncBalanceInBackground(userId: string): Promise<void> {
    // Prevent duplicate syncs for the same user
    if (this.syncingUsers.has(userId)) {
      this.logger.debug(`Sync already in progress for user ${userId}, skipping`);
      return;
    }

    this.syncingUsers.add(userId);

    try {
      const freshData = await this.fetchBalancesFromExchanges(userId);

      // Save to cache
      await this.updateBalanceCache(userId, {
        byAsset: freshData.byAsset,
        byExchange: freshData.byExchange,
        totalValueUsd: freshData.totalValueUsd,
      });

      // Emit event for WebSocket
      this.eventEmitter.emit('balance.updated', {
        userId,
        data: {
          ...freshData,
          isCached: false,
          isSyncing: false,
        },
      });

      this.logger.log(`Balance synced for user ${userId}`);
    } catch (error) {
      this.logger.error(`Background sync failed for user ${userId}: ${error.message}`);
    } finally {
      this.syncingUsers.delete(userId);
    }
  }

  /**
   * Get consolidated balances (returns cache if available, syncs in background)
   */
  async getConsolidatedBalances(userId: string): Promise<ConsolidatedBalanceDto> {
    // 1. Check for cached balance
    const cached = await this.getCachedBalance(userId);

    // 2. If cache exists, return it immediately and sync in background
    if (cached) {
      // Start background sync (don't await)
      this.syncBalanceInBackground(userId).catch((err) =>
        this.logger.error(`Background sync failed: ${err.message}`),
      );

      return {
        byAsset: cached.data.byAsset,
        byExchange: cached.data.byExchange,
        totalValueUsd: cached.data.totalValueUsd,
        lastUpdated: cached.lastSyncAt,
        isCached: true,
        isSyncing: true,
      };
    }

    // 3. No cache - first time user, must wait for sync (no WebSocket event needed)
    const freshData = await this.fetchBalancesFromExchanges(userId);

    // Save to cache for next time
    await this.updateBalanceCache(userId, {
      byAsset: freshData.byAsset,
      byExchange: freshData.byExchange,
      totalValueUsd: freshData.totalValueUsd,
    });

    return {
      ...freshData,
      isCached: false,
      isSyncing: false,
    };
  }

  /**
   * Fetch fresh balances from all exchanges (internal method)
   */
  private async fetchBalancesFromExchanges(userId: string): Promise<ConsolidatedBalanceDto> {
    const credentials = await this.credentialsService.findActiveByUser(userId);
    const exchangeBalances: ExchangeBalanceDto[] = [];
    const assetMap = new Map<string, AssetBalanceDto>();
    const assetExchangesMap = new Map<string, Set<string>>();
    const assetBreakdownMap = new Map<string, Map<string, number>>();

    for (const credential of credentials) {
      try {
        let adapter: IExchangeAdapter;

        if (credential.exchange === ExchangeType.NEXO_MANUAL) {
          // Create a transactions fetcher for NEXO_MANUAL
          const fetchTransactions = async (): Promise<NexoManualTransaction[]> => {
            const transactions = await this.transactionsService.findByCredential(
              credential._id.toString(),
              credential.userId.toString(),
            );
            return transactions.map((tx) => ({
              type: tx.type,
              asset: tx.asset,
              amount: tx.amount,
              inputAsset: tx.rawData?.inputCurrency as string,
              inputAmount: tx.rawData?.inputAmount as number,
              outputAsset: tx.rawData?.outputCurrency as string,
              outputAmount: tx.rawData?.outputAmount as number,
            }));
          };
          adapter = this.exchangeFactory.createNexoManualAdapter(fetchTransactions);
        } else if (credential.exchange === ExchangeType.BINANCE_MANUAL) {
          // Create a transactions fetcher for BINANCE_MANUAL
          const fetchTransactions = async (): Promise<BinanceManualTransaction[]> => {
            const transactions = await this.transactionsService.findByCredential(
              credential._id.toString(),
              credential.userId.toString(),
            );
            return transactions.map((tx) => ({
              type: tx.type,
              asset: tx.asset,
              amount: tx.rawData?.change !== undefined
                ? (tx.rawData.change as number)
                : (tx.type === 'withdrawal' || tx.type === 'fee' ? -tx.amount : tx.amount),
            }));
          };
          adapter = this.exchangeFactory.createBinanceManualAdapter(fetchTransactions);
        } else {
          const decrypted = this.credentialsService.getDecryptedCredentials(credential);
          adapter = this.exchangeFactory.createAdapter(
            credential.exchange as ExchangeType,
            decrypted.apiKey,
            decrypted.apiSecret,
            decrypted.passphrase,
          );
        }

        const balances = await adapter.fetchBalances();

        // Normalize asset names in exchange balances
        const normalizedBalances = balances.map((b) => ({
          asset: this.normalizeAsset(b.asset),
          free: b.free,
          locked: b.locked,
          total: b.total,
        }));

        // Consolidate within exchange (in case there are duplicates after normalization)
        const exchangeAssetMap = new Map<string, AssetBalanceDto>();
        for (const balance of normalizedBalances) {
          const existing = exchangeAssetMap.get(balance.asset);
          if (existing) {
            existing.free += balance.free;
            existing.locked += balance.locked;
            existing.total += balance.total;
          } else {
            exchangeAssetMap.set(balance.asset, { ...balance });
          }
        }

        const exchangeBalance: ExchangeBalanceDto = {
          exchange: credential.exchange,
          label: credential.label,
          credentialId: credential._id.toString(),
          balances: Array.from(exchangeAssetMap.values()),
          totalValueUsd: 0,
        };

        exchangeBalances.push(exchangeBalance);

        // Consolidate by asset across all exchanges
        for (const balance of exchangeBalance.balances) {
          const existing = assetMap.get(balance.asset);
          if (existing) {
            existing.free += balance.free;
            existing.locked += balance.locked;
            existing.total += balance.total;
          } else {
            assetMap.set(balance.asset, {
              asset: balance.asset,
              free: balance.free,
              locked: balance.locked,
              total: balance.total,
            });
          }

          // Track which exchanges have this asset
          if (!assetExchangesMap.has(balance.asset)) {
            assetExchangesMap.set(balance.asset, new Set());
          }
          assetExchangesMap.get(balance.asset).add(credential.exchange);

          // Track breakdown by exchange
          if (!assetBreakdownMap.has(balance.asset)) {
            assetBreakdownMap.set(balance.asset, new Map());
          }
          const exchangeMap = assetBreakdownMap.get(balance.asset);
          const currentTotal = exchangeMap.get(credential.exchange) || 0;
          exchangeMap.set(credential.exchange, currentTotal + balance.total);
        }

        await this.credentialsService.updateLastSync(credential._id);
      } catch (error) {
        this.logger.error(
          `Failed to fetch balances for credential ${credential._id}: ${error.message}`,
        );
        await this.credentialsService.updateLastError(
          credential._id,
          error.message,
        );
      }
    }

    const byAsset = Array.from(assetMap.values());

    // Add exchanges and breakdown to each asset
    for (const balance of byAsset) {
      const exchanges = assetExchangesMap.get(balance.asset);
      if (exchanges) {
        balance.exchanges = Array.from(exchanges);
      }

      const breakdown = assetBreakdownMap.get(balance.asset);
      if (breakdown) {
        balance.exchangeBreakdown = Array.from(breakdown.entries()).map(
          ([exchange, total]) => ({ exchange, total }),
        );
      }
    }

    // Fetch prices for all assets
    const assets = byAsset.map((b) => b.asset);
    const pricesMap = await this.pricesService.getPricesMap(assets);

    // Calculate USD values for byAsset
    let totalValueUsd = 0;
    for (const balance of byAsset) {
      const price = pricesMap[balance.asset];
      if (price && price > 0) {
        balance.priceUsd = price;
        balance.valueUsd = balance.total * price;
        totalValueUsd += balance.valueUsd;
      }
    }

    // Calculate USD values for byExchange
    for (const exchange of exchangeBalances) {
      let exchangeTotal = 0;
      for (const balance of exchange.balances) {
        const price = pricesMap[balance.asset];
        if (price && price > 0) {
          balance.priceUsd = price;
          balance.valueUsd = balance.total * price;
          exchangeTotal += balance.valueUsd;
        }
      }
      exchange.totalValueUsd = exchangeTotal;
    }

    return {
      byAsset,
      byExchange: exchangeBalances,
      totalValueUsd,
      lastUpdated: new Date(),
    };
  }

  async getBalancesByExchange(userId: string): Promise<ExchangeBalanceDto[]> {
    const consolidated = await this.getConsolidatedBalances(userId);
    return consolidated.byExchange;
  }

  async getBalancesByAsset(userId: string): Promise<AssetBalanceDto[]> {
    const consolidated = await this.getConsolidatedBalances(userId);
    return consolidated.byAsset;
  }

  async getBalancesForCredential(
    credentialId: string,
    userId: string,
  ): Promise<IBalance[]> {
    const credential = await this.credentialsService.findById(
      credentialId,
      userId,
    );

    let adapter: IExchangeAdapter;

    if (credential.exchange === ExchangeType.NEXO_MANUAL) {
      const fetchTransactions = async (): Promise<NexoManualTransaction[]> => {
        const transactions = await this.transactionsService.findByCredential(
          credential._id.toString(),
          userId,
        );
        return transactions.map((tx) => ({
          type: tx.type,
          asset: tx.asset,
          amount: tx.amount,
          inputAsset: tx.rawData?.inputCurrency as string,
          inputAmount: tx.rawData?.inputAmount as number,
          outputAsset: tx.rawData?.outputCurrency as string,
          outputAmount: tx.rawData?.outputAmount as number,
        }));
      };
      adapter = this.exchangeFactory.createNexoManualAdapter(fetchTransactions);
    } else if (credential.exchange === ExchangeType.BINANCE_MANUAL) {
      const fetchTransactions = async (): Promise<BinanceManualTransaction[]> => {
        const transactions = await this.transactionsService.findByCredential(
          credential._id.toString(),
          userId,
        );
        return transactions.map((tx) => ({
          type: tx.type,
          asset: tx.asset,
          amount: tx.rawData?.change !== undefined
            ? (tx.rawData.change as number)
            : (tx.type === 'withdrawal' || tx.type === 'fee' ? -tx.amount : tx.amount),
        }));
      };
      adapter = this.exchangeFactory.createBinanceManualAdapter(fetchTransactions);
    } else {
      const decrypted = this.credentialsService.getDecryptedCredentials(credential);
      adapter = this.exchangeFactory.createAdapter(
        credential.exchange as ExchangeType,
        decrypted.apiKey,
        decrypted.apiSecret,
        decrypted.passphrase,
      );
    }

    const balances = await adapter.fetchBalances();
    await this.credentialsService.updateLastSync(credential._id);

    return balances;
  }
}
