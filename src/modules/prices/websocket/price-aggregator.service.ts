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
      // Get symbols from global settings
      const symbols = await this.loadSymbolsFromSettings();

      this.logger.log(`Loaded ${symbols.length} symbols from settings`);

      // Subscribe to symbols
      this.subscribeToSymbolsInternal(symbols);

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

  private async loadSymbolsFromSettings(): Promise<string[]> {
    if (!this.settingsService) {
      this.logger.warn('SettingsService not available, using default symbols');
      return this.defaultSymbols;
    }

    try {
      const symbols = await this.settingsService.getAllConfiguredSymbols();

      // If no symbols configured, use defaults
      if (symbols.length === 0) {
        this.logger.log('No symbols configured in settings, using defaults');
        return this.defaultSymbols;
      }

      return symbols;
    } catch (error) {
      this.logger.error(`Error loading settings: ${error.message}`);
      return this.defaultSymbols;
    }
  }

  private subscribeToSymbolsInternal(symbols: string[]): void {
    // Update current symbols set
    this.currentSymbols = new Set(symbols);
    this.logger.log(`[Subscribe] Total symbols to subscribe: ${symbols.length}`);
    this.logger.log(`[Subscribe] Symbols: ${symbols.join(', ')}`);

    // Clear price cache to remove old symbols
    this.priceCache.clear();

    // Set subscriptions for USDT pairs on Binance (replaces previous)
    const binanceSymbols = symbols.filter((s) => s.includes('/USDT'));
    this.binanceStream.setSubscriptions(binanceSymbols);
    this.logger.log(`[Subscribe] Binance USDT pairs (${binanceSymbols.length}): ${binanceSymbols.join(', ')}`);

    // Set subscriptions for USD pairs on Kraken (replaces previous)
    const krakenSymbols = symbols
      .map((s) => s.replace('USDT', 'USD'))
      .filter((s) => s.includes('/USD'));
    this.krakenStream.setSubscriptions(krakenSymbols);
    this.logger.log(`[Subscribe] Kraken USD pairs (${krakenSymbols.length}): ${krakenSymbols.join(', ')}`);
  }

  async refreshSubscriptions(): Promise<void> {
    const symbols = await this.loadSymbolsFromSettings();
    this.subscribeToSymbolsInternal(symbols);
    this.logger.log(`Refreshed subscriptions with ${symbols.length} symbols`);
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

    if (exchangeIndex >= 0) {
      prices[exchangeIndex] = { exchange: update.exchange, price: update.price };
    } else {
      prices.push({ exchange: update.exchange, price: update.price });
    }

    // Calculate best price (prefer Binance as primary source)
    const aggregated: AggregatedPrice = {
      symbol: normalizedSymbol,
      price: this.calculateBestPrice(prices),
      timestamp: update.timestamp,
      source: update.exchange,
      prices,
    };

    this.priceCache.set(normalizedSymbol, aggregated);

    // Emit event for WebSocket gateway to broadcast
    this.eventEmitter.emit('price.update', aggregated);
  }

  private normalizeSymbol(symbol: string): string {
    // Normalize USD/USDT variations to USDT
    // Only replace /USD if it's at the end (not /USDT which would become /USDTT)
    if (symbol.endsWith('/USD')) {
      return symbol + 'T';
    }
    return symbol;
  }

  private calculateBestPrice(
    prices: { exchange: string; price: number }[],
  ): number {
    // Use Binance as primary source if available
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
    const normalized = this.normalizeSymbol(symbol);
    const price = this.priceCache.get(normalized);

    // Debug: log cache lookup
    if (!price) {
      const cachedKeys = Array.from(this.priceCache.keys());
      this.logger.debug(`[Cache Lookup] ${symbol} -> ${normalized} NOT FOUND. Cached symbols: ${cachedKeys.join(', ')}`);
    }

    return price;
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
