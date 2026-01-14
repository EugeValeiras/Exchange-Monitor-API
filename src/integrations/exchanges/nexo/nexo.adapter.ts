import { BaseExchangeAdapter } from '../base-exchange.adapter';
import {
  IBalance,
  ITransaction,
  IPrice,
} from '../../../common/interfaces/exchange-adapter.interface';
import {
  NexoClient,
  DepositWithdrawalDeal,
  NexoTrade,
} from './nexo.client';

export class NexoAdapter extends BaseExchangeAdapter {
  readonly exchangeName = 'nexo-pro';
  private client: NexoClient;

  constructor(apiKey: string, apiSecret: string) {
    super();
    this.client = new NexoClient({ apiKey, apiSecret });
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.client.getAccountSummary();
      return true;
    } catch (error) {
      this.logger.warn(`Connection test failed: ${error.message}`);
      return false;
    }
  }

  async fetchBalances(): Promise<IBalance[]> {
    try {
      const response = await this.client.getAccountSummary();
      const balances: IBalance[] = [];

      for (const balance of response.balances) {
        const total = parseFloat(balance.totalBalance);
        if (total > 0) {
          balances.push({
            asset: balance.assetName,
            free: parseFloat(balance.availableBalance) || 0,
            locked: parseFloat(balance.lockedBalance) || 0,
            total,
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
      const response = await this.client.getDepositsAndWithdrawals({
        from: since?.getTime(),
        type: 'deposit',
        pageSize: 50,
      });

      return (response.deals || []).map((deal) =>
        this.mapDepositWithdrawal(deal, 'deposit'),
      );
    } catch (error) {
      this.handleError(error as Error, 'fetchDeposits');
    }
  }

  async fetchWithdrawals(since?: Date): Promise<ITransaction[]> {
    try {
      const response = await this.client.getDepositsAndWithdrawals({
        from: since?.getTime(),
        type: 'withdrawal',
        pageSize: 50,
      });

      return (response.deals || []).map((deal) =>
        this.mapDepositWithdrawal(deal, 'withdrawal'),
      );
    } catch (error) {
      this.handleError(error as Error, 'fetchWithdrawals');
    }
  }

  async fetchTrades(since?: Date, _symbol?: string, _symbols?: string[]): Promise<ITransaction[]> {
    try {
      const response = await this.client.getTrades({
        startDate: since?.getTime(),
        pageSize: 50,
      });

      return (response.trades || []).map((trade) => this.mapTrade(trade));
    } catch (error) {
      this.handleError(error as Error, 'fetchTrades');
    }
  }

  private mapDepositWithdrawal(
    deal: DepositWithdrawalDeal,
    type: 'deposit' | 'withdrawal',
  ): ITransaction {
    return {
      externalId: `${deal.timestamp}-${deal.asset}-${type}`,
      type,
      asset: deal.asset,
      amount: Math.abs(parseFloat(deal.amount)),
      timestamp: new Date(deal.timestamp),
      rawData: deal as unknown as Record<string, unknown>,
    };
  }

  private mapTrade(trade: NexoTrade): ITransaction {
    const [baseAsset, quoteAsset] = trade.symbol.split('/');

    return {
      externalId: trade.id,
      type: 'trade',
      asset: baseAsset,
      amount: Math.abs(parseFloat(trade.tradeAmount)),
      price: parseFloat(trade.executedPrice),
      priceAsset: quoteAsset,
      pair: trade.symbol,
      side: trade.side,
      // Nexo trades timestamp is in seconds, convert to milliseconds
      timestamp: new Date(trade.timestamp * 1000),
      rawData: trade as unknown as Record<string, unknown>,
    };
  }

  async fetchPrice(_symbol: string): Promise<IPrice> {
    this.logger.warn('Nexo does not provide direct price API, using fallback');
    throw new Error('Price fetching not supported for Nexo');
  }

  async fetchPrices(_symbols: string[]): Promise<IPrice[]> {
    throw new Error('Price fetching not supported for Nexo');
  }
}
