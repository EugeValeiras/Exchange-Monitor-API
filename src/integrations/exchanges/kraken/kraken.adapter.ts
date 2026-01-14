import * as ccxt from 'ccxt';
import { BaseExchangeAdapter } from '../base-exchange.adapter';
import {
  IBalance,
  ITransaction,
  IPrice,
} from '../../../common/interfaces/exchange-adapter.interface';

export class KrakenAdapter extends BaseExchangeAdapter {
  readonly exchangeName = 'kraken';
  private client: ccxt.kraken;

  constructor(apiKey: string, apiSecret: string) {
    super();
    this.client = new ccxt.kraken({
      apiKey,
      secret: apiSecret,
      enableRateLimit: true,
      options: {
        defaultType: 'spot',
      },
    });
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.client.fetchBalance();
      return true;
    } catch (error) {
      this.logger.warn(`Connection test failed: ${error.message}`);
      return false;
    }
  }

  async fetchBalances(): Promise<IBalance[]> {
    try {
      const balance = await this.client.fetchBalance();
      const balances: IBalance[] = [];

      for (const [asset, total] of Object.entries(balance.total)) {
        const totalNum = total as number;
        if (totalNum > 0) {
          const free = (balance.free[asset] as number) || 0;
          const locked = (balance.used[asset] as number) || 0;
          balances.push({
            asset: this.normalizeAsset(asset),
            free,
            locked,
            total: totalNum,
          });
        }
      }

      return balances;
    } catch (error) {
      this.handleError(error as Error, 'fetchBalances');
    }
  }

  async fetchDeposits(since?: Date): Promise<ITransaction[]> {
    try {
      const sinceTimestamp = since ? since.getTime() : undefined;
      const deposits = await this.client.fetchDeposits(undefined, sinceTimestamp);

      return deposits.map((deposit) => ({
        externalId: deposit.id || deposit.txid || '',
        type: 'deposit' as const,
        asset: this.normalizeAsset(deposit.currency),
        amount: deposit.amount,
        fee: deposit.fee?.cost,
        feeAsset: deposit.fee?.currency,
        timestamp: new Date(deposit.timestamp),
        rawData: deposit.info as Record<string, unknown>,
      }));
    } catch (error) {
      this.handleError(error as Error, 'fetchDeposits');
    }
  }

  async fetchWithdrawals(since?: Date): Promise<ITransaction[]> {
    try {
      const sinceTimestamp = since ? since.getTime() : undefined;
      const withdrawals = await this.client.fetchWithdrawals(
        undefined,
        sinceTimestamp,
      );

      return withdrawals.map((withdrawal) => ({
        externalId: withdrawal.id || withdrawal.txid || '',
        type: 'withdrawal' as const,
        asset: this.normalizeAsset(withdrawal.currency),
        amount: withdrawal.amount,
        fee: withdrawal.fee?.cost,
        feeAsset: withdrawal.fee?.currency,
        timestamp: new Date(withdrawal.timestamp),
        rawData: withdrawal.info as Record<string, unknown>,
      }));
    } catch (error) {
      this.handleError(error as Error, 'fetchWithdrawals');
    }
  }

  async fetchTrades(since?: Date, symbol?: string, symbols?: string[]): Promise<ITransaction[]> {
    try {
      const sinceTimestamp = since ? since.getTime() : undefined;

      // If a specific symbol is provided, fetch only that
      if (symbol) {
        const trades = await this.client.fetchMyTrades(symbol, sinceTimestamp);
        return this.mapTrades(trades);
      }

      // If symbols array is provided, iterate over those
      if (symbols && symbols.length > 0) {
        await this.client.loadMarkets();
        const allTrades: ITransaction[] = [];
        const seenTradeIds = new Set<string>();
        const checkedMarkets = new Set<string>();

        // Extract unique base assets from configured symbols
        const baseAssets = [...new Set(symbols.map(s => s.split('/')[0]))];
        this.logger.log(`Fetching trades for base assets: ${baseAssets.join(', ')}`);

        for (const sym of symbols) {
          // Find all markets for this symbol's base currency
          const markets = this.findKrakenMarkets(sym);

          if (markets.length === 0) {
            this.logger.debug(`No markets found for ${sym}`);
            continue;
          }

          this.logger.log(`Found ${markets.length} Kraken markets for ${sym}: ${markets.join(', ')}`);

          for (const marketSymbol of markets) {
            // Skip if already checked
            if (checkedMarkets.has(marketSymbol)) continue;
            checkedMarkets.add(marketSymbol);

            try {
              const trades = await this.client.fetchMyTrades(marketSymbol, sinceTimestamp);

              for (const trade of trades) {
                if (!seenTradeIds.has(trade.id)) {
                  seenTradeIds.add(trade.id);
                  allTrades.push(...this.mapTrades([trade]));
                }
              }

              if (trades.length > 0) {
                this.logger.log(`Found ${trades.length} trades for ${marketSymbol}`);
              }
            } catch (error) {
              this.logger.debug(`No trades or error for ${marketSymbol}: ${error.message}`);
            }
          }
        }

        this.logger.log(`Total trades fetched: ${allTrades.length}`);
        return allTrades;
      }

      // Fallback: no symbols configured, return empty
      this.logger.warn('No symbols configured for trade sync');
      return [];
    } catch (error) {
      this.handleError(error as Error, 'fetchTrades');
    }
  }

  /**
   * Find all Kraken markets for a given symbol.
   * Returns all markets that match the base currency.
   */
  private findKrakenMarkets(symbol: string): string[] {
    const [base] = symbol.split('/');
    const normalizedBase = this.normalizeAsset(base);
    const foundMarkets: string[] = [];

    // Direct match first
    if (this.client.markets[symbol]) {
      foundMarkets.push(symbol);
    }

    // Find all markets with this base currency
    for (const [marketSymbol, market] of Object.entries(this.client.markets)) {
      if (foundMarkets.includes(marketSymbol)) continue;

      const marketBase = this.normalizeAsset(market.base);
      if (marketBase === normalizedBase) {
        foundMarkets.push(marketSymbol);
      }
    }

    return foundMarkets;
  }

  private mapTrades(trades: ccxt.Trade[]): ITransaction[] {
    return trades.map((trade) => ({
      externalId: trade.id,
      type: 'trade' as const,
      asset: this.normalizeAsset(trade.symbol.split('/')[0]),
      amount: trade.amount,
      fee: trade.fee?.cost,
      feeAsset: trade.fee?.currency ? this.normalizeAsset(trade.fee.currency) : undefined,
      price: trade.price,
      priceAsset: this.normalizeAsset(trade.symbol.split('/')[1]),
      pair: trade.symbol,
      side: trade.side as 'buy' | 'sell',
      timestamp: new Date(trade.timestamp),
      rawData: trade.info as Record<string, unknown>,
    }));
  }

  async fetchPrice(symbol: string): Promise<IPrice> {
    try {
      const ticker = await this.client.fetchTicker(symbol);
      return {
        symbol,
        price: ticker.last || ticker.close || 0,
        timestamp: new Date(ticker.timestamp || Date.now()),
      };
    } catch (error) {
      this.handleError(error as Error, 'fetchPrice');
    }
  }

  async fetchPrices(symbols: string[]): Promise<IPrice[]> {
    try {
      const tickers = await this.client.fetchTickers(symbols);
      return Object.entries(tickers).map(([symbol, ticker]) => ({
        symbol,
        price: ticker.last || ticker.close || 0,
        timestamp: new Date(ticker.timestamp || Date.now()),
      }));
    } catch (error) {
      this.handleError(error as Error, 'fetchPrices');
    }
  }

  /**
   * Fetch ledger entries for buy/sell/convert operations.
   * These are instant purchases that don't appear in regular trade history.
   * @param since - Optional date to fetch ledger entries from
   * @param symbols - Optional array of symbols to filter by (e.g., ['BTC/USD', 'ETH/USDT'])
   */
  async fetchLedger(since?: Date, symbols?: string[]): Promise<ITransaction[]> {
    try {
      // Extract configured base assets from symbols
      const configuredBaseAssets = new Set<string>();
      if (symbols && symbols.length > 0) {
        for (const symbol of symbols) {
          const base = symbol.split('/')[0];
          configuredBaseAssets.add(this.normalizeAsset(base));
        }
        this.logger.log(`Filtering ledger by base assets: ${Array.from(configuredBaseAssets).join(', ')}`);
      }

      const sinceTimestamp = since ? since.getTime() : undefined;
      const ledgerEntries = await this.client.fetchLedger(undefined, sinceTimestamp);

      this.logger.log(`Fetched ${ledgerEntries.length} ledger entries from Kraken`);

      // Group ledger entries by refid to pair spend/receive operations
      const groupedByRef = new Map<string, ccxt.LedgerEntry[]>();

      for (const entry of ledgerEntries) {
        // Skip entries that are already covered by deposits/withdrawals/trades
        const entryType = entry.info?.type as string;
        if (['deposit', 'withdrawal'].includes(entryType)) {
          continue;
        }

        const refId = entry.referenceId || entry.id;
        if (!groupedByRef.has(refId)) {
          groupedByRef.set(refId, []);
        }
        groupedByRef.get(refId)!.push(entry);
      }

      const transactions: ITransaction[] = [];

      for (const [refId, entries] of groupedByRef) {
        // Look for spend/receive pairs (buy/sell/convert operations)
        const spendEntry = entries.find(e => (e.info?.type as string) === 'spend');
        const receiveEntry = entries.find(e => (e.info?.type as string) === 'receive');

        if (spendEntry && receiveEntry) {
          // This is a buy/sell/convert operation
          const spentAsset = this.normalizeAsset(spendEntry.currency);
          const receivedAsset = this.normalizeAsset(receiveEntry.currency);
          const spentAmount = Math.abs(spendEntry.amount);
          const receivedAmount = Math.abs(receiveEntry.amount);

          // Determine if it's a buy or sell based on which asset is the quote currency
          const stablecoins = ['USD', 'USDT', 'USDC', 'EUR', 'GBP'];
          const isBuy = stablecoins.includes(spentAsset);

          const baseAsset = isBuy ? receivedAsset : spentAsset;
          const quoteAsset = isBuy ? spentAsset : receivedAsset;

          // Filter by configured base assets if provided
          if (configuredBaseAssets.size > 0 && !configuredBaseAssets.has(baseAsset)) {
            continue;
          }

          const amount = isBuy ? receivedAmount : spentAmount;
          const price = isBuy ? spentAmount / receivedAmount : receivedAmount / spentAmount;

          transactions.push({
            externalId: `ledger-${refId}`,
            type: 'trade' as const,
            asset: baseAsset,
            amount,
            price,
            priceAsset: quoteAsset,
            pair: `${baseAsset}/${quoteAsset}`,
            side: isBuy ? 'buy' : 'sell',
            timestamp: new Date(spendEntry.timestamp || receiveEntry.timestamp),
            rawData: {
              spendEntry: spendEntry.info,
              receiveEntry: receiveEntry.info,
              refId,
            } as Record<string, unknown>,
          });

          this.logger.debug(
            `Ledger ${isBuy ? 'BUY' : 'SELL'}: ${amount} ${baseAsset} @ ${price} ${quoteAsset}`,
          );
        }
      }

      this.logger.log(`Processed ${transactions.length} buy/sell/convert transactions from ledger`);
      return transactions;
    } catch (error) {
      this.handleError(error as Error, 'fetchLedger');
    }
  }
}
