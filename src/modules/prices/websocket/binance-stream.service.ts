import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as WebSocket from 'ws';
import {
  IExchangeStream,
  PriceUpdate,
  StreamConfig,
} from './exchange-stream.interface';

const WS_OPEN = 1; // WS_OPEN constant

@Injectable()
export class BinanceStreamService implements IExchangeStream, OnModuleDestroy {
  private readonly logger = new Logger(BinanceStreamService.name);
  readonly exchangeName = 'binance';

  private ws: WebSocket | null = null;
  private subscribedSymbols: Set<string> = new Set();
  private priceCallback: ((price: PriceUpdate) => void) | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;

  private readonly config: StreamConfig = {
    reconnectInterval: 5000,
    maxReconnectAttempts: 10,
    pingInterval: 30000,
  };

  async connect(): Promise<void> {
    if (this.ws?.readyState === WS_OPEN) {
      return;
    }

    return new Promise((resolve, reject) => {
      const symbols = Array.from(this.subscribedSymbols);
      const streams = symbols
        .map((s) => `${s.toLowerCase().replace('/', '')}@ticker`)
        .join('/');
      const url =
        symbols.length > 0
          ? `wss://stream.binance.com:9443/stream?streams=${streams}`
          : `wss://stream.binance.com:9443/ws/btcusdt@ticker`;

      this.logger.log(`Connecting to Binance WebSocket: ${url}`);
      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        this.logger.log('Binance WebSocket connected');
        this.reconnectAttempts = 0;
        this.startPingInterval();
        resolve();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        this.handleMessage(data);
      });

      this.ws.on('close', () => {
        this.logger.warn('Binance WebSocket disconnected');
        this.clearTimers();
        this.scheduleReconnect();
      });

      this.ws.on('error', (error) => {
        this.logger.error(`Binance WebSocket error: ${error.message}`);
        if (this.reconnectAttempts === 0) {
          reject(error);
        }
      });

      this.ws.on('pong', () => {
        this.logger.debug('Binance pong received');
      });
    });
  }

  private handleMessage(data: WebSocket.Data): void {
    try {
      const parsed = JSON.parse(data.toString());

      // Combined stream format: { stream: "btcusdt@ticker", data: {...} }
      if (parsed.stream && parsed.data) {
        const ticker = parsed.data;
        if (ticker.e === '24hrTicker') {
          this.emitPrice({
            exchange: 'binance',
            symbol: this.normalizeSymbol(ticker.s),
            price: parseFloat(ticker.c),
            timestamp: new Date(ticker.E),
          });
        }
      }
      // Single stream format
      else if (parsed.e === '24hrTicker') {
        this.emitPrice({
          exchange: 'binance',
          symbol: this.normalizeSymbol(parsed.s),
          price: parseFloat(parsed.c),
          timestamp: new Date(parsed.E),
        });
      }
    } catch (error) {
      this.logger.error(`Failed to parse Binance message: ${error.message}`);
    }
  }

  private normalizeSymbol(binanceSymbol: string): string {
    // BTCUSDT -> BTC/USDT
    const quotes = ['USDT', 'USD', 'BTC', 'ETH', 'BNB'];
    for (const quote of quotes) {
      if (binanceSymbol.endsWith(quote)) {
        const base = binanceSymbol.slice(0, -quote.length);
        return `${base}/${quote}`;
      }
    }
    return binanceSymbol;
  }

  private emitPrice(price: PriceUpdate): void {
    if (this.priceCallback) {
      this.priceCallback(price);
    }
  }

  subscribe(symbols: string[]): void {
    const newSymbols = symbols.filter((s) => !this.subscribedSymbols.has(s));
    if (newSymbols.length === 0) return;

    this.logger.log(`Subscribing to Binance symbols: ${newSymbols.join(', ')}`);
    newSymbols.forEach((s) => this.subscribedSymbols.add(s));

    // Reconnect with new symbols
    if (this.ws?.readyState === WS_OPEN) {
      this.disconnect();
      this.connect().catch((err) =>
        this.logger.error(`Reconnect failed: ${err.message}`),
      );
    }
  }

  /**
   * Replace all subscriptions with the given symbols
   */
  setSubscriptions(symbols: string[]): void {
    this.subscribedSymbols.clear();
    symbols.forEach((s) => this.subscribedSymbols.add(s));
    this.logger.log(`Set Binance subscriptions to: ${symbols.join(', ')}`);

    // Reconnect with new symbols
    if (this.ws?.readyState === WS_OPEN) {
      this.disconnect();
      this.connect().catch((err) =>
        this.logger.error(`Reconnect failed: ${err.message}`),
      );
    }
  }

  unsubscribe(symbols: string[]): void {
    symbols.forEach((s) => this.subscribedSymbols.delete(s));
  }

  onPrice(callback: (price: PriceUpdate) => void): void {
    this.priceCallback = callback;
  }

  isConnected(): boolean {
    return this.ws?.readyState === WS_OPEN;
  }

  disconnect(): void {
    this.clearTimers();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      this.logger.error('Max reconnect attempts reached for Binance');
      return;
    }

    const delay =
      this.config.reconnectInterval * Math.pow(2, this.reconnectAttempts);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempts++;
      this.logger.log(
        `Reconnecting to Binance (attempt ${this.reconnectAttempts})`,
      );
      this.connect().catch((err) =>
        this.logger.error(`Reconnect failed: ${err.message}`),
      );
    }, delay);
  }

  private startPingInterval(): void {
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WS_OPEN) {
        this.ws.ping();
      }
    }, this.config.pingInterval);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  onModuleDestroy(): void {
    this.disconnect();
  }
}
