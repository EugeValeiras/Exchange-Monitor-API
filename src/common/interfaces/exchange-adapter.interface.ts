export interface IBalance {
  asset: string;
  free: number;
  locked: number;
  total: number;
}

export interface ITransaction {
  externalId: string;
  type: 'deposit' | 'withdrawal' | 'trade' | 'transfer' | 'interest' | 'fee';
  asset: string;
  amount: number;
  fee?: number;
  feeAsset?: string;
  price?: number;
  priceAsset?: string;
  pair?: string;
  side?: 'buy' | 'sell';
  timestamp: Date;
  rawData: Record<string, unknown>;
}

export interface IPrice {
  symbol: string;
  price: number;
  timestamp: Date;
}

export interface IExchangeAdapter {
  readonly exchangeName: string;

  testConnection(): Promise<boolean>;
  fetchBalances(): Promise<IBalance[]>;
  fetchDeposits(since?: Date): Promise<ITransaction[]>;
  fetchWithdrawals(since?: Date): Promise<ITransaction[]>;
  fetchTrades(since?: Date, symbol?: string, symbols?: string[]): Promise<ITransaction[]>;
  fetchLedger?(since?: Date, symbols?: string[]): Promise<ITransaction[]>;
  fetchPrice(symbol: string): Promise<IPrice>;
  fetchPrices(symbols: string[]): Promise<IPrice[]>;
}
