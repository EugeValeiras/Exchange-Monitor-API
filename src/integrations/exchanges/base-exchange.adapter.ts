import { Logger } from '@nestjs/common';
import {
  IExchangeAdapter,
  IBalance,
  ITransaction,
  IPrice,
} from '../../common/interfaces/exchange-adapter.interface';

export abstract class BaseExchangeAdapter implements IExchangeAdapter {
  protected readonly logger: Logger;
  abstract readonly exchangeName: string;

  constructor() {
    this.logger = new Logger(this.constructor.name);
  }

  abstract testConnection(): Promise<boolean>;
  abstract fetchBalances(): Promise<IBalance[]>;
  abstract fetchDeposits(since?: Date): Promise<ITransaction[]>;
  abstract fetchWithdrawals(since?: Date): Promise<ITransaction[]>;
  abstract fetchTrades(since?: Date, symbol?: string): Promise<ITransaction[]>;
  abstract fetchPrice(symbol: string): Promise<IPrice>;
  abstract fetchPrices(symbols: string[]): Promise<IPrice[]>;

  protected normalizeAsset(asset: string): string {
    const mappings: Record<string, string> = {
      XBT: 'BTC',
      XXBT: 'BTC',
      XETH: 'ETH',
      ZUSD: 'USD',
      ZEUR: 'EUR',
      XXRP: 'XRP',
      XXLM: 'XLM',
    };
    return mappings[asset] || asset;
  }

  protected handleError(error: Error, operation: string): never {
    this.logger.error(`Error in ${operation}: ${error.message}`, error.stack);
    throw new Error(`${this.exchangeName} ${operation} failed: ${error.message}`);
  }
}
