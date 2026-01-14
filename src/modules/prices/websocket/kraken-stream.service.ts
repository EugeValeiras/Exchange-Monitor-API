import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as WebSocket from 'ws';
import {
  IExchangeStream,
  PriceUpdate,
  StreamConfig,
} from './exchange-stream.interface';

const WS_OPEN = 1; // WS_OPEN constant

@Injectable()
export class KrakenStreamService implements IExchangeStream, OnModuleDestroy {
  private readonly logger = new Logger(KrakenStreamService.name);
  readonly exchangeName = 'kraken';

  private ws: WebSocket | null = null;
  private subscribedSymbols: Set<string> = new Set();
  private priceCallback: ((price: PriceUpdate) => void) | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

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
      this.logger.log('Connecting to Kraken WebSocket');
      this.ws = new WebSocket('wss://ws.kraken.com');

      this.ws.on('open', () => {
        this.logger.log('Kraken WebSocket connected');
        this.reconnectAttempts = 0;
        this.subscribeToSymbols();
        resolve();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        this.handleMessage(data);
      });

      this.ws.on('close', () => {
        this.logger.warn('Kraken WebSocket disconnected');
        this.clearTimers();
        this.scheduleReconnect();
      });

      this.ws.on('error', (error) => {
        this.logger.error(`Kraken WebSocket error: ${error.message}`);
        if (this.reconnectAttempts === 0) {
          reject(error);
        }
      });

      this.ws.on('pong', () => {
        this.logger.debug('Kraken pong received');
      });
    });
  }

  private subscribeToSymbols(): void {
    if (this.ws?.readyState !== WS_OPEN) return;

    const symbols = Array.from(this.subscribedSymbols);
    if (symbols.length === 0) {
      // Subscribe to BTC/USD by default
      symbols.push('BTC/USD');
    }

    const pairs = symbols.map((s) => this.toKrakenPair(s));

    const subscribeMessage = {
      event: 'subscribe',
      pair: pairs,
      subscription: { name: 'ticker' },
    };

    this.ws.send(JSON.stringify(subscribeMessage));
    this.logger.log(`Subscribed to Kraken pairs: ${pairs.join(', ')}`);
  }

  private toKrakenPair(symbol: string): string {
    // BTC/USD -> XBT/USD (Kraken uses XBT for Bitcoin)
    // Also handle USDT -> USD for Kraken
    return symbol.replace('BTC', 'XBT').replace('USDT', 'USD');
  }

  private fromKrakenPair(krakenPair: string): string {
    // XBT/USD -> BTC/USD
    return krakenPair.replace('XBT', 'BTC');
  }

  private handleMessage(data: WebSocket.Data): void {
    try {
      const parsed = JSON.parse(data.toString());

      // Heartbeat
      if (parsed.event === 'heartbeat') {
        return;
      }

      // System status / subscription status
      if (
        parsed.event === 'systemStatus' ||
        parsed.event === 'subscriptionStatus'
      ) {
        this.logger.debug(`Kraken ${parsed.event}: ${JSON.stringify(parsed)}`);
        return;
      }

      // Ticker data: [channelId, tickerData, channelName, pair]
      if (Array.isArray(parsed) && parsed.length >= 4) {
        const [, tickerData, channelName, pair] = parsed;

        if (channelName === 'ticker' && tickerData?.c) {
          // c = close price [price, lot volume]
          // o = opening price [today, last 24h]
          // h = high [today, last 24h]
          // l = low [today, last 24h]
          const price = parseFloat(tickerData.c[0]);
          const openPrice24h = tickerData.o ? parseFloat(tickerData.o[1]) : 0;
          const change24h = openPrice24h > 0
            ? ((price - openPrice24h) / openPrice24h) * 100
            : 0;

          this.emitPrice({
            exchange: 'kraken',
            symbol: this.fromKrakenPair(pair),
            price,
            timestamp: new Date(),
            change24h,
            high24h: tickerData.h ? parseFloat(tickerData.h[1]) : undefined,
            low24h: tickerData.l ? parseFloat(tickerData.l[1]) : undefined,
          });
        }
      }
    } catch (error) {
      this.logger.error(`Failed to parse Kraken message: ${error.message}`);
    }
  }

  private emitPrice(price: PriceUpdate): void {
    if (this.priceCallback) {
      this.priceCallback(price);
    }
  }

  subscribe(symbols: string[]): void {
    const newSymbols = symbols.filter((s) => !this.subscribedSymbols.has(s));
    if (newSymbols.length === 0) return;

    this.logger.log(`Subscribing to Kraken symbols: ${newSymbols.join(', ')}`);
    newSymbols.forEach((s) => this.subscribedSymbols.add(s));

    if (this.ws?.readyState === WS_OPEN) {
      const pairs = newSymbols.map((s) => this.toKrakenPair(s));
      this.ws.send(
        JSON.stringify({
          event: 'subscribe',
          pair: pairs,
          subscription: { name: 'ticker' },
        }),
      );
    }
  }

  /**
   * Replace all subscriptions with the given symbols
   */
  setSubscriptions(symbols: string[]): void {
    // Unsubscribe from all current symbols
    const currentSymbols = Array.from(this.subscribedSymbols);
    if (currentSymbols.length > 0 && this.ws?.readyState === WS_OPEN) {
      const pairs = currentSymbols.map((s) => this.toKrakenPair(s));
      this.ws.send(
        JSON.stringify({
          event: 'unsubscribe',
          pair: pairs,
          subscription: { name: 'ticker' },
        }),
      );
    }

    // Clear and set new symbols
    this.subscribedSymbols.clear();
    symbols.forEach((s) => this.subscribedSymbols.add(s));
    this.logger.log(`Set Kraken subscriptions to: ${symbols.join(', ')}`);

    // Subscribe to new symbols
    if (this.ws?.readyState === WS_OPEN) {
      const pairs = symbols.map((s) => this.toKrakenPair(s));
      this.ws.send(
        JSON.stringify({
          event: 'subscribe',
          pair: pairs,
          subscription: { name: 'ticker' },
        }),
      );
    }
  }

  unsubscribe(symbols: string[]): void {
    const toUnsubscribe = symbols.filter((s) => this.subscribedSymbols.has(s));
    if (toUnsubscribe.length === 0) return;

    toUnsubscribe.forEach((s) => this.subscribedSymbols.delete(s));

    if (this.ws?.readyState === WS_OPEN) {
      const pairs = toUnsubscribe.map((s) => this.toKrakenPair(s));
      this.ws.send(
        JSON.stringify({
          event: 'unsubscribe',
          pair: pairs,
          subscription: { name: 'ticker' },
        }),
      );
    }
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
      this.logger.error('Max reconnect attempts reached for Kraken');
      return;
    }

    const delay =
      this.config.reconnectInterval * Math.pow(2, this.reconnectAttempts);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempts++;
      this.logger.log(
        `Reconnecting to Kraken (attempt ${this.reconnectAttempts})`,
      );
      this.connect().catch((err) =>
        this.logger.error(`Reconnect failed: ${err.message}`),
      );
    }, delay);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  onModuleDestroy(): void {
    this.disconnect();
  }
}
