import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { IExchangeStream, PriceUpdate } from './exchange-stream.interface';

interface NexoPair {
  pair: string;
  currentPrice: string;
  minAmount: string;
  maxAmount: string;
}

interface NexoPairsResponse {
  orderMetadata: {
    content: NexoPair[];
  };
}

@Injectable()
export class NexoStreamService implements IExchangeStream, OnModuleDestroy {
  private readonly logger = new Logger(NexoStreamService.name);
  readonly exchangeName = 'nexo';

  private readonly baseUrl = 'https://pro-api.nexo.io';
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly pollingIntervalMs: number;

  private priceCallback?: (price: PriceUpdate) => void;
  private subscribedSymbols = new Set<string>();
  private pollingInterval?: NodeJS.Timeout;
  private connected = false;

  constructor(private configService: ConfigService) {
    this.apiKey = this.configService.get<string>('NEXO_API_KEY') || '';
    this.apiSecret = this.configService.get<string>('NEXO_API_SECRET') || '';
    this.pollingIntervalMs = this.configService.get<number>('NEXO_POLLING_INTERVAL_MS') || 5000;

    if (!this.apiKey || !this.apiSecret) {
      this.logger.warn('Nexo API credentials not configured - price streaming disabled');
    }
  }

  private generateSignature(nonce: number): string {
    return crypto
      .createHmac('sha256', this.apiSecret)
      .update(nonce.toString())
      .digest('base64');
  }

  private getAuthHeaders(): Record<string, string> {
    const nonce = Date.now();
    return {
      'X-API-KEY': this.apiKey,
      'X-NONCE': nonce.toString(),
      'X-SIGNATURE': this.generateSignature(nonce),
      'Content-Type': 'application/json',
    };
  }

  async connect(): Promise<void> {
    if (!this.apiKey || !this.apiSecret) {
      this.logger.warn('Cannot connect Nexo stream - credentials not configured');
      return;
    }

    if (this.connected) {
      this.logger.debug('Nexo stream already connected');
      return;
    }

    this.logger.log('Starting Nexo polling stream...');
    this.connected = true;
    this.startPolling();
  }

  disconnect(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = undefined;
    }
    this.connected = false;
    this.logger.log('Nexo polling stream disconnected');
  }

  subscribe(symbols: string[]): void {
    for (const symbol of symbols) {
      this.subscribedSymbols.add(symbol);
    }
    this.logger.debug(`Subscribed to ${symbols.length} symbols on Nexo`);
  }

  unsubscribe(symbols: string[]): void {
    for (const symbol of symbols) {
      this.subscribedSymbols.delete(symbol);
    }
    this.logger.debug(`Unsubscribed from ${symbols.length} symbols on Nexo`);
  }

  setSubscriptions(symbols: string[]): void {
    this.subscribedSymbols.clear();
    this.subscribe(symbols);
  }

  onPrice(callback: (price: PriceUpdate) => void): void {
    this.priceCallback = callback;
  }

  isConnected(): boolean {
    return this.connected;
  }

  onModuleDestroy(): void {
    this.disconnect();
  }

  private startPolling(): void {
    // Fetch immediately on start
    this.fetchPrices();

    // Then poll at the configured interval
    this.pollingInterval = setInterval(() => {
      this.fetchPrices();
    }, this.pollingIntervalMs);
  }

  private async fetchPrices(): Promise<void> {
    if (!this.priceCallback || this.subscribedSymbols.size === 0) {
      return;
    }

    try {
      const response = await fetch(`${this.baseUrl}/api/v1/pairs`, {
        method: 'GET',
        headers: this.getAuthHeaders(),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`Nexo API error: ${response.status} - ${errorText}`);
        return;
      }

      const data: NexoPairsResponse = await response.json();
      const pairs = data.orderMetadata?.content || [];

      for (const pair of pairs) {
        // Convert Nexo pair format (BTC/USDT) to our standard format
        const symbol = pair.pair;

        // Only emit prices for subscribed symbols
        if (!this.subscribedSymbols.has(symbol)) {
          continue;
        }

        const price = parseFloat(pair.currentPrice);
        if (isNaN(price) || price <= 0) {
          continue;
        }

        const priceUpdate: PriceUpdate = {
          exchange: this.exchangeName,
          symbol,
          price,
          timestamp: new Date(),
          // Nexo /pairs endpoint doesn't provide 24h change data
        };

        this.priceCallback(priceUpdate);
      }
    } catch (error) {
      this.logger.error(`Error fetching Nexo prices: ${error.message}`);
    }
  }
}
