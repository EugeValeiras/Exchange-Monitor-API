import { Injectable, Logger, Optional, Inject, forwardRef } from '@nestjs/common';
import { ExchangeCredentialsService } from '../exchange-credentials/exchange-credentials.service';
import { SettingsService } from '../settings/settings.service';
import { ExchangeFactoryService } from '../../integrations/exchanges/exchange-factory.service';
import { ExchangeType } from '../../common/constants/exchanges.constant';
import { IPrice } from '../../common/interfaces/exchange-adapter.interface';
import { PriceResponseDto, ConvertResponseDto } from './dto/price-response.dto';
import { PriceAggregatorService } from './websocket/price-aggregator.service';

@Injectable()
export class PricesService {
  private readonly logger = new Logger(PricesService.name);
  private priceCache = new Map<string, { price: number; timestamp: Date }>();
  private readonly cacheTtlMs = 60000; // 1 minute cache

  // USDT is the base currency, always valued at 1
  private readonly stablecoins = new Set(['USDT']);

  // Assets that cannot be priced (delisted, illiquid, etc.)
  private readonly unpriceable = new Set([
    'ETHW', 'LUNA', 'LUNC', 'UST',
  ]);

  constructor(
    private readonly credentialsService: ExchangeCredentialsService,
    @Inject(forwardRef(() => SettingsService))
    private readonly settingsService: SettingsService,
    private readonly exchangeFactory: ExchangeFactoryService,
    @Optional() private readonly priceAggregator?: PriceAggregatorService,
  ) {}

  async getPrice(symbol: string, userId?: string): Promise<PriceResponseDto> {
    // Check cache first
    const cached = this.priceCache.get(symbol);
    if (cached && Date.now() - cached.timestamp.getTime() < this.cacheTtlMs) {
      return {
        symbol,
        price: cached.price,
        timestamp: cached.timestamp,
      };
    }

    // Try to get price from any available exchange
    const exchanges = [ExchangeType.BINANCE, ExchangeType.KRAKEN];

    for (const exchange of exchanges) {
      try {
        const price = await this.fetchPriceFromExchange(exchange, symbol, userId);
        if (price) {
          this.priceCache.set(symbol, {
            price: price.price,
            timestamp: price.timestamp,
          });
          return price;
        }
      } catch (error) {
        this.logger.debug(`Failed to get price from ${exchange}: ${error.message}`);
      }
    }

    throw new Error(`Unable to fetch price for ${symbol}`);
  }

  async getPrices(symbols: string[], userId?: string): Promise<PriceResponseDto[]> {
    const prices: PriceResponseDto[] = [];

    for (const symbol of symbols) {
      try {
        const price = await this.getPrice(symbol, userId);
        prices.push(price);
      } catch (error) {
        this.logger.warn(`Failed to get price for ${symbol}: ${error.message}`);
      }
    }

    return prices;
  }

  async getPricesForUserAssets(userId: string): Promise<PriceResponseDto[]> {
    const credentials = await this.credentialsService.findActiveByUser(userId);
    const assets = new Set<string>();

    for (const credential of credentials) {
      try {
        const decrypted = this.credentialsService.getDecryptedCredentials(credential);
        const adapter = this.exchangeFactory.createAdapter(
          credential.exchange as ExchangeType,
          decrypted.apiKey,
          decrypted.apiSecret,
          decrypted.passphrase,
        );

        const balances = await adapter.fetchBalances();
        for (const balance of balances) {
          if (balance.total > 0 && balance.asset !== 'USD' && balance.asset !== 'USDT') {
            assets.add(balance.asset);
          }
        }
      } catch (error) {
        this.logger.warn(`Failed to fetch assets from ${credential.exchange}`);
      }
    }

    const symbols = Array.from(assets).map((asset) => `${asset}/USDT`);
    return this.getPrices(symbols, userId);
  }

  async convert(
    from: string,
    to: string,
    amount: number,
    userId?: string,
  ): Promise<ConvertResponseDto> {
    let rate: number;

    if (to === 'USD' || to === 'USDT') {
      const price = await this.getPrice(`${from}/USDT`, userId);
      rate = price.price;
    } else if (from === 'USD' || from === 'USDT') {
      const price = await this.getPrice(`${to}/USDT`, userId);
      rate = 1 / price.price;
    } else {
      const fromPrice = await this.getPrice(`${from}/USDT`, userId);
      const toPrice = await this.getPrice(`${to}/USDT`, userId);
      rate = fromPrice.price / toPrice.price;
    }

    return {
      from,
      to,
      amount,
      result: amount * rate,
      rate,
    };
  }

  async getPricesMap(assets: string[]): Promise<Record<string, number>> {
    const pricesMap: Record<string, number> = {};
    const assetsNeedingFetch: string[] = [];

    // First pass: get prices from WebSocket cache and handle special cases
    for (const asset of assets) {
      const normalized = this.normalizeAsset(asset);

      // Check if it's a stablecoin
      if (this.stablecoins.has(normalized)) {
        pricesMap[asset] = 1;
        continue;
      }

      // Check if it's unpriceable
      if (this.unpriceable.has(normalized)) {
        pricesMap[asset] = 0;
        continue;
      }

      // Try to get from WebSocket cache first (instant!)
      // Try USDT first, then USD (treated as equivalent)
      if (this.priceAggregator) {
        let wsPrice = this.priceAggregator.getLatestPrice(`${normalized}/USDT`);
        if (wsPrice && wsPrice.price > 0) {
          pricesMap[asset] = wsPrice.price;
          this.logger.debug(`[WS Cache HIT] ${asset} (${normalized}/USDT) = ${wsPrice.price}`);
          continue;
        }
        wsPrice = this.priceAggregator.getLatestPrice(`${normalized}/USD`);
        if (wsPrice && wsPrice.price > 0) {
          pricesMap[asset] = wsPrice.price;
          this.logger.debug(`[WS Cache HIT] ${asset} (${normalized}/USD) = ${wsPrice.price}`);
          continue;
        }
        this.logger.debug(`[WS Cache MISS] ${asset}`);
      }

      // Also check local cache (USDT first, then USD)
      let cached = this.priceCache.get(`${normalized}/USDT`);
      if (cached && Date.now() - cached.timestamp.getTime() < this.cacheTtlMs) {
        pricesMap[asset] = cached.price;
        continue;
      }
      cached = this.priceCache.get(`${normalized}/USD`);
      if (cached && Date.now() - cached.timestamp.getTime() < this.cacheTtlMs) {
        pricesMap[asset] = cached.price;
        continue;
      }

      // Need to fetch from API
      assetsNeedingFetch.push(asset);
    }

    // If all prices were found in cache, return immediately
    if (assetsNeedingFetch.length === 0) {
      this.logger.debug(`All ${assets.length} prices found in WebSocket cache`);
      return pricesMap;
    }

    // Filter assets by configured symbols - only fetch prices for configured pairs
    const configuredAssets = await this.getConfiguredSymbols();
    const assetsToFetch: string[] = [];
    const skippedAssets: string[] = [];

    for (const asset of assetsNeedingFetch) {
      const normalized = this.normalizeAsset(asset);
      if (configuredAssets.has(normalized)) {
        assetsToFetch.push(asset);
      } else {
        // Asset not configured → price = 0
        pricesMap[asset] = 0;
        skippedAssets.push(asset);
      }
    }

    if (skippedAssets.length > 0) {
      this.logger.debug(
        `Skipping ${skippedAssets.length} unconfigured assets: ${skippedAssets.join(', ')}`,
      );
    }

    // If all remaining assets are unconfigured, return
    if (assetsToFetch.length === 0) {
      this.logger.debug('No configured assets need REST fetch');
      return pricesMap;
    }

    this.logger.debug(
      `Fetching ${assetsToFetch.length} prices via REST (${assetsToFetch.join(', ')})`,
    );

    // Group remaining assets by normalized symbol
    const normalizedToOriginal = new Map<string, string[]>();
    for (const asset of assetsToFetch) {
      const normalized = this.normalizeAsset(asset);
      const existing = normalizedToOriginal.get(normalized) || [];
      existing.push(asset);
      normalizedToOriginal.set(normalized, existing);
    }

    // Fetch prices for assets not in cache
    for (const [normalized, originalAssets] of normalizedToOriginal) {
      try {
        let price: PriceResponseDto | null = null;

        try {
          price = await this.getPrice(`${normalized}/USDT`);
        } catch {
          try {
            price = await this.getPrice(`${normalized}/USD`);
          } catch {
            // Both failed
          }
        }

        if (price) {
          for (const original of originalAssets) {
            pricesMap[original] = price.price;
          }
        } else {
          this.logger.warn(`Failed to get price for ${normalized}`);
          for (const original of originalAssets) {
            pricesMap[original] = 0;
          }
        }
      } catch (error) {
        this.logger.warn(`Failed to get price for ${normalized}`);
        for (const original of originalAssets) {
          pricesMap[original] = 0;
        }
      }
    }

    return pricesMap;
  }

  /**
   * Normalizes asset names to their tradeable counterparts
   * - LDBNB -> BNB (Binance Locked Defi)
   * - LDBTC -> BTC
   * etc.
   */
  private normalizeAsset(asset: string): string {
    // Binance Locked Defi products have "LD" prefix
    if (asset.startsWith('LD') && asset.length > 2) {
      return asset.substring(2);
    }

    // Binance Flexible products have "F" prefix sometimes
    if (asset.startsWith('F') && asset.length > 1 && /^F[A-Z]{2,}$/.test(asset)) {
      const stripped = asset.substring(1);
      // Only strip if the result is a known asset pattern
      if (['BTC', 'ETH', 'BNB', 'SOL', 'USDT', 'USDC'].includes(stripped)) {
        return stripped;
      }
    }

    return asset;
  }

  /**
   * Gets all configured symbols (base assets) from global settings
   */
  private async getConfiguredSymbols(): Promise<Set<string>> {
    return this.settingsService.getConfiguredBaseAssets();
  }

  private async fetchPriceFromExchange(
    exchange: ExchangeType,
    symbol: string,
    userId?: string,
  ): Promise<IPrice | null> {
    // For public prices, we can use ccxt without authentication
    const ccxt = await import('ccxt');

    let client: InstanceType<typeof ccxt.Exchange>;
    switch (exchange) {
      case ExchangeType.BINANCE:
        client = new ccxt.binance({ enableRateLimit: true });
        break;
      case ExchangeType.KRAKEN:
        client = new ccxt.kraken({ enableRateLimit: true });
        break;
      default:
        return null;
    }

    try {
      const ticker = await client.fetchTicker(symbol);
      return {
        symbol,
        price: ticker.last || ticker.close || 0,
        timestamp: new Date(ticker.timestamp || Date.now()),
      };
    } catch {
      return null;
    }
  }
}
