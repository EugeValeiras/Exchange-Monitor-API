export interface IExchangeStream {
  readonly exchangeName: string;
  connect(): Promise<void>;
  disconnect(): void;
  subscribe(symbols: string[]): void;
  unsubscribe(symbols: string[]): void;
  setSubscriptions(symbols: string[]): void;
  onPrice(callback: (price: PriceUpdate) => void): void;
  isConnected(): boolean;
}

export interface PriceUpdate {
  exchange: string;
  symbol: string;
  price: number;
  timestamp: Date;
}

export interface AggregatedPrice {
  symbol: string;
  price: number;
  timestamp: Date;
  source: string;
  prices: { exchange: string; price: number }[];
}

export interface StreamConfig {
  reconnectInterval: number;
  maxReconnectAttempts: number;
  pingInterval: number;
}
