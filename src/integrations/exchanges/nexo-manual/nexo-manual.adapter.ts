import { BaseExchangeAdapter } from '../base-exchange.adapter';
import {
  IBalance,
  ITransaction,
  IPrice,
} from '../../../common/interfaces/exchange-adapter.interface';
import { TransactionType } from '../../../common/constants/transaction-types.constant';

export interface NexoManualTransaction {
  type: TransactionType;
  asset: string;
  amount: number;
  inputAsset?: string;
  inputAmount?: number;
  outputAsset?: string;
  outputAmount?: number;
}

export type TransactionsFetcher = () => Promise<NexoManualTransaction[]>;

export class NexoManualAdapter extends BaseExchangeAdapter {
  readonly exchangeName = 'nexo-manual';

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

  private calculateBalances(transactions: NexoManualTransaction[]): IBalance[] {
    const balanceMap = new Map<string, number>();

    for (const tx of transactions) {
      switch (tx.type) {
        case TransactionType.DEPOSIT:
        case TransactionType.INTEREST:
          // Add to balance
          if (tx.outputAsset && tx.outputAmount) {
            const current = balanceMap.get(tx.outputAsset) || 0;
            balanceMap.set(tx.outputAsset, current + tx.outputAmount);
          } else if (tx.asset && tx.amount) {
            const current = balanceMap.get(tx.asset) || 0;
            balanceMap.set(tx.asset, current + Math.abs(tx.amount));
          }
          break;

        case TransactionType.WITHDRAWAL:
          // Subtract from balance
          if (tx.inputAsset && tx.inputAmount) {
            const current = balanceMap.get(tx.inputAsset) || 0;
            balanceMap.set(tx.inputAsset, current - Math.abs(tx.inputAmount));
          } else if (tx.asset && tx.amount) {
            const current = balanceMap.get(tx.asset) || 0;
            balanceMap.set(tx.asset, current - Math.abs(tx.amount));
          }
          break;

        case TransactionType.TRADE:
          // Exchange: subtract input, add output
          if (tx.inputAsset && tx.inputAmount) {
            const currentInput = balanceMap.get(tx.inputAsset) || 0;
            balanceMap.set(tx.inputAsset, currentInput - Math.abs(tx.inputAmount));
          }
          if (tx.outputAsset && tx.outputAmount) {
            const currentOutput = balanceMap.get(tx.outputAsset) || 0;
            balanceMap.set(tx.outputAsset, currentOutput + Math.abs(tx.outputAmount));
          }
          break;

        case TransactionType.TRANSFER:
        default:
          // For transfers, use output as add (incoming)
          if (tx.outputAsset && tx.outputAmount && tx.outputAmount > 0) {
            const current = balanceMap.get(tx.outputAsset) || 0;
            balanceMap.set(tx.outputAsset, current + tx.outputAmount);
          }
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

  // Transactions are imported from CSV, not fetched from API
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
    throw new Error('Price fetching not supported for Nexo Manual');
  }

  async fetchPrices(_symbols: string[]): Promise<IPrice[]> {
    throw new Error('Price fetching not supported for Nexo Manual');
  }
}
