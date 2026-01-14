import { BaseExchangeAdapter } from '../base-exchange.adapter';
import {
  IBalance,
  ITransaction,
  IPrice,
} from '../../../common/interfaces/exchange-adapter.interface';
import { TransactionType } from '../../../common/constants/transaction-types.constant';

export interface BinanceManualTransaction {
  type: TransactionType;
  asset: string;
  amount: number;
}

export type TransactionsFetcher = () => Promise<BinanceManualTransaction[]>;

export class BinanceManualAdapter extends BaseExchangeAdapter {
  readonly exchangeName = 'binance-manual';

  constructor(private readonly fetchTransactions: TransactionsFetcher) {
    super();
  }

  async testConnection(): Promise<boolean> {
    // Always returns true - no external API to test
    return true;
  }

  async fetchBalances(): Promise<IBalance[]> {
    try {
      const transactions = await this.fetchTransactions();
      return this.calculateBalances(transactions);
    } catch (error) {
      this.handleError(error as Error, 'fetchBalances');
    }
  }

  private calculateBalances(transactions: BinanceManualTransaction[]): IBalance[] {
    const balanceMap = new Map<string, number>();

    for (const tx of transactions) {
      const current = balanceMap.get(tx.asset) || 0;

      switch (tx.type) {
        case TransactionType.DEPOSIT:
        case TransactionType.INTEREST:
          // Add to balance
          balanceMap.set(tx.asset, current + Math.abs(tx.amount));
          break;

        case TransactionType.WITHDRAWAL:
        case TransactionType.FEE:
          // Subtract from balance
          balanceMap.set(tx.asset, current - Math.abs(tx.amount));
          break;

        case TransactionType.TRADE:
          // For trades, we use the change amount (can be positive or negative)
          balanceMap.set(tx.asset, current + tx.amount);
          break;

        case TransactionType.TRANSFER:
        default:
          // For transfers, use the amount as is
          balanceMap.set(tx.asset, current + tx.amount);
          break;
      }
    }

    // Convert to IBalance array, filtering out zero/negative balances
    return Array.from(balanceMap.entries())
      .filter(([, total]) => total > 0.00000001) // Filter dust
      .map(([asset, total]) => ({
        asset,
        free: total,
        locked: 0,
        total,
      }));
  }

  // Transactions are imported from Excel, not fetched from API
  async fetchDeposits(_since?: Date): Promise<ITransaction[]> {
    return [];
  }

  async fetchWithdrawals(_since?: Date): Promise<ITransaction[]> {
    return [];
  }

  async fetchTrades(_since?: Date, _symbol?: string, _symbols?: string[]): Promise<ITransaction[]> {
    return [];
  }

  async fetchPrice(_symbol: string): Promise<IPrice> {
    throw new Error('Price fetching not supported for Binance Manual');
  }

  async fetchPrices(_symbols: string[]): Promise<IPrice[]> {
    throw new Error('Price fetching not supported for Binance Manual');
  }
}
