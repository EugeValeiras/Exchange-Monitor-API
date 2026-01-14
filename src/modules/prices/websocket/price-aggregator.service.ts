import { Injectable, Logger, OnModuleInit, Optional, Inject, forwardRef } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { BinanceStreamService } from './binance-stream.service';
import { KrakenStreamService } from './kraken-stream.service';
import { PriceUpdate, AggregatedPrice } from './exchange-stream.interface';
import { SettingsService } from '../../settings/settings.service';

@Injectable()
export class PriceAggregatorService implements OnModuleInit {
  private readonly logger = new Logger(PriceAggregatorService.name);
  private priceCache = new Map<string, AggregatedPrice>();
  private currentSymbols: Set<string> = new Set();

  // Default symbols to subscribe on startup (fallback)
  private readonly defaultSymbols = [
    'BTC/USDT',
    'ETH/USDT',
    'BNB/USDT',
    'SOL/USDT',
    'XRP/USDT',
    'ADA/USDT',
    'DOGE/USDT',
    'DOT/USDT',
    'MATIC/USDT',
    'LINK/USDT',
    'AVAX/USDT',
    'ATOM/USDT',
  ];

  constructor(
    private readonly binanceStream: BinanceStreamService,
    private readonly krakenStream: KrakenStreamService,
    private readonly eventEmitter: EventEmitter2,
    @Optional() @Inject(forwardRef(() => SettingsService))
    private readonly settingsService?: SettingsService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.setupPriceHandlers();
    await this.initializeStreamsFromSettings();
  }

  @OnEvent('settings.symbols.updated')
  async handleSymbolsUpdated(): Promise<void> {
    this.logger.log('Settings symbols updated, refreshing subscriptions...');
    await this.refreshSubscriptions();
  }

  private setupPriceHandlers(): void {
    this.binanceStream.onPrice((price) => this.handlePriceUpdate(price));
    this.krakenStream.onPrice((price) => this.handlePriceUpdate(price));
  }

  private async initializeStreamsFromSettings(): Promise<void> {
    try {
      // Get symbols grouped by exchange
      const symbolsByExchange = await this.loadSymbolsByExchange();
      const total = Object.values(symbolsByExchange).reduce((acc, s) => acc + s.length, 0);

      this.logger.log(`Loaded ${total} symbols from settings`);

      // Subscribe to symbols
      this.subscribeToSymbolsInternal(symbolsByExchange);

      // Connect to both streams
      await Promise.allSettled([
        this.binanceStream.connect(),
        this.krakenStream.connect(),
      ]).then((results) => {
        results.forEach((result, index) => {
          const exchange = index === 0 ? 'Binance' : 'Kraken';
          if (result.status === 'fulfilled') {
            this.logger.log(`${exchange} stream connected`);
          } else {
            this.logger.error(
              `${exchange} stream failed: ${result.reason?.message}`,
            );
          }
        });
      });

      this.logger.log('Price streams initialization completed');
    } catch (error) {
      this.logger.error(`Failed to initialize streams: ${error.message}`);
    }
  }

  private async loadSymbolsByExchange(): Promise<Record<string, string[]>> {
    if (!this.settingsService) {
      this.logger.warn('SettingsService not available, using default symbols');
      return { binance: this.defaultSymbols };
    }

    try {
      const symbolsByExchange = await this.settingsService.getAllConfiguredSymbolsByExchange();

      // If no symbols configured, use defaults for Binance
      const hasSymbols = Object.values(symbolsByExchange).some((s) => s.length > 0);
      if (!hasSymbols) {
        this.logger.log('No symbols configured in settings, using defaults');
        return { binance: this.defaultSymbols };
      }

      return symbolsByExchange;
    } catch (error) {
      this.logger.error(`Error loading settings: ${error.message}`);
      return { binance: this.defaultSymbols };
    }
  }

  private subscribeToSymbolsInternal(symbolsByExchange: Record<string, string[]>): void {
    // Update current symbols set (all symbols from all exchanges)
    const allSymbols: string[] = [];
    Object.values(symbolsByExchange).forEach((symbols) => {
      allSymbols.push(...symbols);
    });
    this.currentSymbols = new Set(allSymbols);

    this.logger.log(`[Subscribe] Total symbols: ${allSymbols.length}`);

    // Clear price cache to remove old symbols
    this.priceCache.clear();

    // Subscribe Binance to its configured symbols
    const binanceSymbols = symbolsByExchange['binance'] || [];
    if (binanceSymbols.length > 0) {
      this.binanceStream.setSubscriptions(binanceSymbols);
      this.logger.log(`[Subscribe] Binance (${binanceSymbols.length}): ${binanceSymbols.join(', ')}`);
    }

    // Subscribe Kraken to its configured symbols
    const krakenSymbols = symbolsByExchange['kraken'] || [];
    if (krakenSymbols.length > 0) {
      this.krakenStream.setSubscriptions(krakenSymbols);
      this.logger.log(`[Subscribe] Kraken (${krakenSymbols.length}): ${krakenSymbols.join(', ')}`);
    }
  }

  async refreshSubscriptions(): Promise<void> {
    const symbolsByExchange = await this.loadSymbolsByExchange();
    this.subscribeToSymbolsInternal(symbolsByExchange);
    const total = Object.values(symbolsByExchange).reduce((acc, s) => acc + s.length, 0);
    this.logger.log(`Refreshed subscriptions with ${total} total symbols`);
  }

  private handlePriceUpdate(update: PriceUpdate): void {
    const normalizedSymbol = this.normalizeSymbol(update.symbol);

    // Only process prices for configured symbols
    if (!this.currentSymbols.has(normalizedSymbol)) {
      return;
    }

    const existing = this.priceCache.get(normalizedSymbol);

    const prices = existing?.prices ? [...existing.prices] : [];
    const exchangeIndex = prices.findIndex(
      (p) => p.exchange === update.exchange,
    );

    const priceEntry = {
      exchange: update.exchange,
      price: update.price,
      change24h: update.change24h,
    };

    if (exchangeIndex >= 0) {
      prices[exchangeIndex] = priceEntry;
    } else {
      prices.push(priceEntry);
    }

    // Calculate best price (prefer Kraken for USD, Binance for USDT)
    const aggregated: AggregatedPrice = {
      symbol: normalizedSymbol,
      price: this.calculateBestPrice(prices),
      timestamp: update.timestamp,
      source: update.exchange,
      prices,
      change24h: update.change24h,
      high24h: update.high24h,
      low24h: update.low24h,
    };

    this.priceCache.set(normalizedSymbol, aggregated);

    // Emit event for WebSocket gateway to broadcast
    this.eventEmitter.emit('price.update', aggregated);
  }

  private normalizeSymbol(symbol: string): string {
    // Keep USD and USDT as separate entries - no conversion
    // This allows us to prefer real USD prices over USDT
    return symbol;
  }

  private calculateBestPrice(
    prices: { exchange: string; price: number }[],
  ): number {
    // Prefer Kraken (real USD) over Binance (USDT) for accurate USD valuation
    const krakenPrice = prices.find((p) => p.exchange === 'kraken');
    if (krakenPrice) {
      return krakenPrice.price;
    }

    // Fallback to Binance (USDT ≈ USD)
    const binancePrice = prices.find((p) => p.exchange === 'binance');
    if (binancePrice) {
      return binancePrice.price;
    }

    // Fallback to average
    if (prices.length === 0) return 0;
    const sum = prices.reduce((acc, p) => acc + p.price, 0);
    return sum / prices.length;
  }

  getLatestPrice(symbol: string): AggregatedPrice | undefined {
    return this.priceCache.get(symbol);
  }

  getAllPrices(): AggregatedPrice[] {
    return Array.from(this.priceCache.values());
  }

  getPricesMap(): Map<string, number> {
    const map = new Map<string, number>();
    this.priceCache.forEach((value, key) => {
      // Store with base asset as key (e.g., "BTC" instead of "BTC/USDT")
      const baseAsset = key.split('/')[0];
      map.set(baseAsset, value.price);
    });
    return map;
  }

  subscribeToSymbols(symbols: string[]): void {
    // Only allow subscribing to symbols that are already configured
    // This prevents dynamic subscription to unconfigured symbols
    const configuredSymbols = symbols.filter((s) => this.currentSymbols.has(s));

    if (configuredSymbols.length === 0) {
      this.logger.debug(`No configured symbols to subscribe from request: ${symbols.join(', ')}`);
      return;
    }

    // These symbols are already subscribed via initializeStreamsFromSettings
    // Just log that the client requested them
    this.logger.debug(`Client requested symbols (already configured): ${configuredSymbols.join(', ')}`);
  }

  getConnectionStatus(): { binance: boolean; kraken: boolean } {
    return {
      binance: this.binanceStream.isConnected(),
      kraken: this.krakenStream.isConnected(),
    };
  }
}
