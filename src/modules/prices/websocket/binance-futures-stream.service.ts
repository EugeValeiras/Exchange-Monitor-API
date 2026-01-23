import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as WebSocket from 'ws';
import {
  IExchangeStream,
  PriceUpdate,
  StreamConfig,
} from './exchange-stream.interface';

const WS_OPEN = 1;

@Injectable()
export class BinanceFuturesStreamService implements IExchangeStream, OnModuleDestroy {
  private readonly logger = new Logger(BinanceFuturesStreamService.name);
  readonly exchangeName = 'binance-futures';

  private ws: WebSocket | null = null;
  private subscribedSymbols: Set<string> = new Set();
  private priceCallback: ((price: PriceUpdate) => void) | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private readonly streamHost: string;

  private readonly config: StreamConfig = {
    reconnectInterval: 5000,
    maxReconnectAttempts: 10,
    pingInterval: 30000,
  };

  constructor(private readonly configService: ConfigService) {
    this.streamHost = this.configService.get<string>('BINANCE_FUTURES_STREAM_HOST') || 'fstream.binance.com';
    this.logger.log(`Using Binance Futures stream host: ${this.streamHost}`);
  }

  async connect(): Promise<void> {
    if (this.ws?.readyState === WS_OPEN) {
      return;
    }

    if (this.subscribedSymbols.size === 0) {
      this.logger.log('No futures symbols to subscribe, skipping connection');
      return;
    }

    return new Promise((resolve, reject) => {
      const symbols = Array.from(this.subscribedSymbols);
      const streams = symbols
        .map((s) => `${this.toFuturesSymbol(s).toLowerCase()}@ticker`)
        .join('/');
      const url = `wss://${this.streamHost}/stream?streams=${streams}`;

      this.logger.log(`Connecting to Binance Futures WebSocket: ${url}`);
      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        this.logger.log('Binance Futures WebSocket connected');
        this.reconnectAttempts = 0;
        this.startPingInterval();
        resolve();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        this.handleMessage(data);
      });

      this.ws.on('close', () => {
        this.logger.warn('Binance Futures WebSocket disconnected');
        this.clearTimers();
        this.scheduleReconnect();
      });

      this.ws.on('error', (error) => {
        this.logger.error(`Binance Futures WebSocket error: ${error.message}`);
        if (this.reconnectAttempts === 0) {
          reject(error);
        }
      });

      this.ws.on('pong', () => {
        this.logger.debug('Binance Futures pong received');
      });
    });
  }

  /**
   * Convert internal symbol format to Binance Futures format
   * MON/USDT:USDT -> MONUSDT
   * BTC/USDT:USDT -> BTCUSDT
   */
  private toFuturesSymbol(symbol: string): string {
    // Remove the :USDT suffix and the slash
    return symbol.replace(':USDT', '').replace('/', '');
  }

  /**
   * Convert Binance Futures symbol back to internal format
   * MONUSDT -> MON/USDT:USDT
   */
  private toInternalSymbol(futuresSymbol: string): string {
    const quotes = ['USDT', 'USD', 'BUSD'];
    for (const quote of quotes) {
      if (futuresSymbol.endsWith(quote)) {
        const base = futuresSymbol.slice(0, -quote.length);
        // For USDT-margined perpetuals, add :USDT suffix
        return `${base}/${quote}:USDT`;
      }
    }
    return futuresSymbol;
  }

  private handleMessage(data: WebSocket.Data): void {
    try {
      const parsed = JSON.parse(data.toString());

      // Combined stream format: { stream: "monusdt@ticker", data: {...} }
      if (parsed.stream && parsed.data) {
        const ticker = parsed.data;
        if (ticker.e === '24hrTicker') {
          const internalSymbol = this.toInternalSymbol(ticker.s);

          // Only emit if this symbol is in our subscribed set
          if (this.subscribedSymbols.has(internalSymbol)) {
            this.emitPrice({
              exchange: 'binance-futures',
              symbol: internalSymbol,
              price: parseFloat(ticker.c),
              timestamp: new Date(ticker.E),
              change24h: parseFloat(ticker.P),
              high24h: parseFloat(ticker.h),
              low24h: parseFloat(ticker.l),
            });
          }
        }
      }
      // Single stream format
      else if (parsed.e === '24hrTicker') {
        const internalSymbol = this.toInternalSymbol(parsed.s);

        if (this.subscribedSymbols.has(internalSymbol)) {
          this.emitPrice({
            exchange: 'binance-futures',
            symbol: internalSymbol,
            price: parseFloat(parsed.c),
            timestamp: new Date(parsed.E),
            change24h: parseFloat(parsed.P),
            high24h: parseFloat(parsed.h),
            low24h: parseFloat(parsed.l),
          });
        }
      }
    } catch (error) {
      this.logger.error(`Failed to parse Binance Futures message: ${error.message}`);
    }
  }

  private emitPrice(price: PriceUpdate): void {
    if (this.priceCallback) {
      this.priceCallback(price);
    }
  }

  subscribe(symbols: string[]): void {
    // Only subscribe to futures symbols (those with :USDT suffix)
    const futuresSymbols = symbols.filter((s) => s.includes(':USDT'));
    const newSymbols = futuresSymbols.filter((s) => !this.subscribedSymbols.has(s));

    if (newSymbols.length === 0) return;

    this.logger.log(`Subscribing to Binance Futures symbols: ${newSymbols.join(', ')}`);
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
    // Only subscribe to futures symbols (those with :USDT suffix)
    const futuresSymbols = symbols.filter((s) => s.includes(':USDT'));

    this.subscribedSymbols.clear();
    futuresSymbols.forEach((s) => this.subscribedSymbols.add(s));

    if (futuresSymbols.length > 0) {
      this.logger.log(`Set Binance Futures subscriptions to: ${futuresSymbols.join(', ')}`);
    }

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
    if (this.subscribedSymbols.size === 0) {
      return;
    }

    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      this.logger.error('Max reconnect attempts reached for Binance Futures');
      return;
    }

    const delay =
      this.config.reconnectInterval * Math.pow(2, this.reconnectAttempts);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempts++;
      this.logger.log(
        `Reconnecting to Binance Futures (attempt ${this.reconnectAttempts})`,
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
