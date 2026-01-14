import * as ccxt from 'ccxt';
import { BaseExchangeAdapter } from '../base-exchange.adapter';
import {
  IBalance,
  ITransaction,
  IPrice,
} from '../../../common/interfaces/exchange-adapter.interface';

export class BinanceAdapter extends BaseExchangeAdapter {
  readonly exchangeName = 'binance';
  private client: ccxt.binance;

  constructor(apiKey: string, apiSecret: string) {
    super();
    this.client = new ccxt.binance({
      apiKey,
      secret: apiSecret,
      enableRateLimit: true,
      options: {
        defaultType: 'spot',
        adjustForTimeDifference: true,
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
            asset,
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
        asset: deposit.currency,
        amount: deposit.amount,
        fee: deposit.fee?.cost,
        feeAsset: deposit.fee?.currency,
        timestamp: new Date(deposit.timestamp),
        rawData: deposit.info as Record<string, unknown>,
      }));
    } catch (error) {
      this.logger.warn(
        `fetchDeposits may require withdraw permission: ${error.message}`,
      );
      return [];
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
        asset: withdrawal.currency,
        amount: withdrawal.amount,
        fee: withdrawal.fee?.cost,
        feeAsset: withdrawal.fee?.currency,
        timestamp: new Date(withdrawal.timestamp),
        rawData: withdrawal.info as Record<string, unknown>,
      }));
    } catch (error) {
      this.logger.warn(
        `fetchWithdrawals may require withdraw permission: ${error.message}`,
      );
      return [];
    }
  }

  async fetchTrades(since?: Date, symbol?: string): Promise<ITransaction[]> {
    try {
      const sinceTimestamp = since ? since.getTime() : undefined;

      if (!symbol) {
        await this.client.loadMarkets();
        const commonPairs = ['BTC/USDT', 'ETH/USDT', 'BNB/USDT'];
        const allTrades: ITransaction[] = [];

        for (const pair of commonPairs) {
          if (this.client.markets[pair]) {
            const trades = await this.client.fetchMyTrades(pair, sinceTimestamp);
            allTrades.push(...this.mapTrades(trades));
          }
        }
        return allTrades;
      }

      const trades = await this.client.fetchMyTrades(symbol, sinceTimestamp);
      return this.mapTrades(trades);
    } catch (error) {
      this.handleError(error as Error, 'fetchTrades');
    }
  }

  private mapTrades(trades: ccxt.Trade[]): ITransaction[] {
    return trades.map((trade) => ({
      externalId: trade.id,
      type: 'trade' as const,
      asset: trade.symbol.split('/')[0],
      amount: trade.amount,
      fee: trade.fee?.cost,
      feeAsset: trade.fee?.currency,
      price: trade.price,
      priceAsset: trade.symbol.split('/')[1],
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
}
