import { Injectable, Logger, Optional, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExchangeCredentialsService } from '../exchange-credentials/exchange-credentials.service';
import { SettingsService } from '../settings/settings.service';
import { ExchangeFactoryService } from '../../integrations/exchanges/exchange-factory.service';
import { ExchangeType } from '../../common/constants/exchanges.constant';
import { IPrice } from '../../common/interfaces/exchange-adapter.interface';
import { NexoClient } from '../../integrations/exchanges/nexo/nexo.client';
import { PriceResponseDto, ConvertResponseDto } from './dto/price-response.dto';
import {
  SwapPreviewResponseDto,
  SwapExchangeResultDto,
} from './dto/swap-preview.dto';
import { SwapExecutionResultDto } from './dto/swap-execute.dto';
import { PriceAggregatorService } from './websocket/price-aggregator.service';

@Injectable()
export class PricesService {
  private readonly logger = new Logger(PricesService.name);
  private priceCache = new Map<string, { price: number; timestamp: Date }>();
  private readonly cacheTtlMs = 60000; // 1 minute cache
  private readonly binanceHostname?: string;
  private marketsCache = new Map<
    string,
    { markets: Record<string, any>; timestamp: number }
  >();
  private readonly marketsCacheTtlMs = 10 * 60 * 1000; // 10 min

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
    private readonly configService: ConfigService,
    @Optional() private readonly priceAggregator?: PriceAggregatorService,
  ) {
    this.binanceHostname = this.configService.get<string>('BINANCE_HOSTNAME');
  }

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
    const exchanges = [ExchangeType.BINANCE, ExchangeType.KRAKEN, ExchangeType.COINBASE];

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
      // Try USDT first, then USD, then futures (USDT:USDT)
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
        // Try futures symbol (e.g., MON/USDT:USDT)
        wsPrice = this.priceAggregator.getLatestPrice(`${normalized}/USDT:USDT`);
        if (wsPrice && wsPrice.price > 0) {
          pricesMap[asset] = wsPrice.price;
          this.logger.debug(`[WS Cache HIT] ${asset} (${normalized}/USDT:USDT futures) = ${wsPrice.price}`);
          continue;
        }
        this.logger.debug(`[WS Cache MISS] ${asset}`);
      }

      // Also check local cache (USDT first, then USD, then futures)
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
      cached = this.priceCache.get(`${normalized}/USDT:USDT`);
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
            // Try futures symbol as last resort
            try {
              price = await this.getPrice(`${normalized}/USDT:USDT`);
              this.logger.debug(`[REST] Got futures price for ${normalized}/USDT:USDT`);
            } catch {
              // All failed
            }
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

  /**
   * Get historical prices for multiple assets at a specific date
   * Uses Binance klines API to fetch OHLCV data
   */
  async getHistoricalPricesMap(
    assets: string[],
    date: Date,
  ): Promise<Record<string, number>> {
    const pricesMap: Record<string, number> = {};
    const ccxt = await import('ccxt');

    // Create Binance client
    const config: any = { enableRateLimit: true };
    if (this.binanceHostname === 'binance.us') {
      const client = new ccxt.binanceus(config);
      return this.fetchHistoricalPricesWithClient(client, assets, date, pricesMap);
    } else {
      if (this.binanceHostname) {
        config.hostname = this.binanceHostname;
      }
      const client = new ccxt.binance(config);
      return this.fetchHistoricalPricesWithClient(client, assets, date, pricesMap);
    }
  }

  private async fetchHistoricalPricesWithClient(
    client: any,
    assets: string[],
    date: Date,
    pricesMap: Record<string, number>,
  ): Promise<Record<string, number>> {
    const timestamp = date.getTime();

    for (const asset of assets) {
      const normalized = this.normalizeAsset(asset);

      // Handle stablecoins
      if (this.stablecoins.has(normalized)) {
        pricesMap[asset] = 1;
        continue;
      }

      // Handle unpriceable assets
      if (this.unpriceable.has(normalized)) {
        pricesMap[asset] = 0;
        continue;
      }

      try {
        // Try USDT pair first
        const symbol = `${normalized}/USDT`;
        const ohlcv = await client.fetchOHLCV(symbol, '1d', timestamp, 1);

        if (ohlcv && ohlcv.length > 0) {
          // Use close price [timestamp, open, high, low, close, volume]
          pricesMap[asset] = ohlcv[0][4];
          this.logger.debug(`Historical price for ${asset} on ${date.toISOString().split('T')[0]}: $${ohlcv[0][4]}`);
        } else {
          pricesMap[asset] = 0;
        }
      } catch (error) {
        // Try USD pair as fallback
        try {
          const symbol = `${normalized}/USD`;
          const ohlcv = await client.fetchOHLCV(symbol, '1d', timestamp, 1);
          if (ohlcv && ohlcv.length > 0) {
            pricesMap[asset] = ohlcv[0][4];
          } else {
            pricesMap[asset] = 0;
          }
        } catch {
          this.logger.debug(`No historical price found for ${asset}`);
          pricesMap[asset] = 0;
        }
      }

      // Small delay to respect rate limits
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return pricesMap;
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
      case ExchangeType.BINANCE: {
        const config: any = { enableRateLimit: true };
        if (this.binanceHostname === 'binance.us') {
          client = new ccxt.binanceus(config);
        } else {
          if (this.binanceHostname) {
            config.hostname = this.binanceHostname;
          }
          client = new ccxt.binance(config);
        }
        break;
      }
      case ExchangeType.KRAKEN:
        client = new ccxt.kraken({ enableRateLimit: true });
        break;
      case ExchangeType.COINBASE:
        client = new ccxt.coinbase({ enableRateLimit: true });
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

  // ── Swap Preview ───────────────────────────────────────────────

  async getSwapPreview(
    from: string,
    to: string,
    amount: number,
    userId?: string,
  ): Promise<SwapPreviewResponseDto> {
    const exchangeConfigs: { type: ExchangeType; label: string }[] = [
      { type: ExchangeType.BINANCE, label: 'Binance' },
      { type: ExchangeType.KRAKEN, label: 'Kraken' },
      { type: ExchangeType.COINBASE, label: 'Coinbase' },
    ];

    const results: SwapExchangeResultDto[] = [];

    const promises: Promise<void>[] = exchangeConfigs.map(async (config) => {
      try {
        const result = await this.calculateSwapForExchange(
          config.type,
          config.label,
          from,
          to,
          amount,
          userId,
        );
        if (result) results.push(result);
      } catch (error) {
        this.logger.debug(
          `Swap preview failed for ${config.label}: ${error.message}`,
        );
      }
    });

    // Add Nexo if user has credentials
    if (userId) {
      promises.push(
        this.calculateSwapForNexo(from, to, amount, userId).then((result) => {
          if (result) results.push(result);
        }).catch((error) => {
          this.logger.debug(`Swap preview failed for Nexo: ${error.message}`);
        }),
      );
    }

    await Promise.all(promises);

    results.sort((a, b) => b.netAmount - a.netAmount);
    if (results.length > 0) {
      results[0].isBest = true;
    }

    return { from, to, amount, results };
  }

  private async calculateSwapForExchange(
    exchangeType: ExchangeType,
    label: string,
    from: string,
    to: string,
    amount: number,
    userId?: string,
  ): Promise<SwapExchangeResultDto | null> {
    const client = this.createPublicCcxtClient(exchangeType);
    if (!client) return null;

    const markets = await this.loadMarketsWithCache(client, exchangeType);

    // Try to get real user fees via authenticated client
    const userFees = userId
      ? await this.getUserFees(exchangeType, userId)
      : null;

    // Try direct pair FROM/TO (and USD/USDT variants)
    const directPairs = this.getPairVariants(from, to, markets);
    for (const pair of directPairs) {
      const market = markets[pair];
      if (!market?.active) continue;

      try {
        const ticker = await client.fetchTicker(pair);
        const bid = ticker.bid || ticker.last || 0;
        if (bid <= 0) continue;

        const takerFee = userFees?.taker ?? market.taker ?? 0;
        const makerFee = userFees?.maker ?? market.maker ?? 0;
        const grossAmount = amount * bid;
        const feeAmount = grossAmount * takerFee;

        return {
          exchange: exchangeType,
          exchangeLabel: label,
          rate: bid,
          takerFeeRate: takerFee,
          makerFeeRate: makerFee,
          feeAmount,
          grossAmount,
          netAmount: grossAmount - feeAmount,
          pair,
          route: null,
          isBest: false,
        };
      } catch {
        continue;
      }
    }

    // Try reverse pair TO/FROM (buy TO with FROM)
    const reversePairs = this.getPairVariants(to, from, markets);
    for (const pair of reversePairs) {
      const market = markets[pair];
      if (!market?.active) continue;

      try {
        const ticker = await client.fetchTicker(pair);
        const ask = ticker.ask || ticker.last || 0;
        if (ask <= 0) continue;

        const takerFee = userFees?.taker ?? market.taker ?? 0;
        const makerFee = userFees?.maker ?? market.maker ?? 0;
        const grossAmount = amount / ask;
        const feeAmount = grossAmount * takerFee;

        return {
          exchange: exchangeType,
          exchangeLabel: label,
          rate: 1 / ask,
          takerFeeRate: takerFee,
          makerFeeRate: makerFee,
          feeAmount,
          grossAmount,
          netAmount: grossAmount - feeAmount,
          pair,
          route: null,
          isBest: false,
        };
      } catch {
        continue;
      }
    }

    // Route through stablecoin (USDT or USD)
    return this.calculateSwapViaStablecoin(
      client,
      exchangeType,
      label,
      from,
      to,
      amount,
      markets,
      userFees,
    );
  }

  private async calculateSwapViaStablecoin(
    client: any,
    exchangeType: ExchangeType,
    label: string,
    from: string,
    to: string,
    amount: number,
    markets: Record<string, any>,
    userFees?: { taker: number; maker: number } | null,
  ): Promise<SwapExchangeResultDto | null> {
    const stablecoins = ['USDT', 'USD'];

    for (const stable of stablecoins) {
      if (from === stable || to === stable) continue;

      // FROM/stable pair
      const fromPairs = this.getPairVariants(from, stable, markets);
      const fromPair = fromPairs.find((p) => markets[p]?.active);
      if (!fromPair) continue;

      // TO/stable pair
      const toPairs = this.getPairVariants(to, stable, markets);
      const toPair = toPairs.find((p) => markets[p]?.active);
      if (!toPair) continue;

      try {
        const [fromTicker, toTicker] = await Promise.all([
          client.fetchTicker(fromPair),
          client.fetchTicker(toPair),
        ]);

        const fromBid = fromTicker.bid || fromTicker.last || 0;
        const toAsk = toTicker.ask || toTicker.last || 0;
        if (fromBid <= 0 || toAsk <= 0) continue;

        const fromFee = userFees?.taker ?? markets[fromPair].taker ?? 0;
        const toFee = userFees?.taker ?? markets[toPair].taker ?? 0;
        const fromMaker = userFees?.maker ?? markets[fromPair].maker ?? 0;
        const toMaker = userFees?.maker ?? markets[toPair].maker ?? 0;

        // Step 1: sell FROM at bid, deduct fee
        const stableAmount = amount * fromBid * (1 - fromFee);
        // Step 2: buy TO at ask, deduct fee
        const grossTo = stableAmount / toAsk;
        const toFeeAmount = grossTo * toFee;
        const netAmount = grossTo - toFeeAmount;

        const totalFeeAmount =
          amount * fromBid * fromFee + toFeeAmount;
        const combinedFeeRate = 1 - (1 - fromFee) * (1 - toFee);

        return {
          exchange: exchangeType,
          exchangeLabel: label,
          rate: fromBid / toAsk,
          takerFeeRate: combinedFeeRate,
          makerFeeRate: fromMaker + toMaker,
          feeAmount: totalFeeAmount,
          grossAmount: (amount * fromBid) / toAsk,
          netAmount,
          pair: `${fromPair} → ${toPair}`,
          route: [fromPair, toPair],
          isBest: false,
        };
      } catch {
        continue;
      }
    }

    return null;
  }

  private async calculateSwapForNexo(
    from: string,
    to: string,
    amount: number,
    userId: string,
  ): Promise<SwapExchangeResultDto | null> {
    const credentials = await this.credentialsService.findActiveByUser(userId);
    const nexoCred = credentials.find(
      (c) => c.exchange === ExchangeType.NEXO_PRO,
    );
    if (!nexoCred) return null;

    const decrypted =
      this.credentialsService.getDecryptedCredentials(nexoCred);
    const client = new NexoClient({
      apiKey: decrypted.apiKey,
      apiSecret: decrypted.apiSecret,
    });

    // Try direct pair (sell FROM for TO)
    const directPair = `${from}/${to}`;
    try {
      const quote = await client.getQuote({
        pair: directPair,
        amount: amount.toString(),
        side: 'sell',
      });

      const price = parseFloat(quote.price);
      if (price > 0) {
        const grossAmount = amount * price;
        return {
          exchange: ExchangeType.NEXO_PRO,
          exchangeLabel: 'Nexo Pro',
          rate: price,
          takerFeeRate: 0,
          makerFeeRate: 0,
          feeAmount: 0,
          grossAmount,
          netAmount: grossAmount,
          pair: directPair,
          route: null,
          isBest: false,
        };
      }
    } catch {
      // Direct pair not available, try reverse
    }

    // Try reverse pair (buy TO with FROM)
    const reversePair = `${to}/${from}`;
    try {
      const quote = await client.getQuote({
        pair: reversePair,
        amount: amount.toString(),
        side: 'buy',
      });

      const price = parseFloat(quote.price);
      if (price > 0) {
        const grossAmount = amount / price;
        return {
          exchange: ExchangeType.NEXO_PRO,
          exchangeLabel: 'Nexo Pro',
          rate: 1 / price,
          takerFeeRate: 0,
          makerFeeRate: 0,
          feeAmount: 0,
          grossAmount,
          netAmount: grossAmount,
          pair: reversePair,
          route: null,
          isBest: false,
        };
      }
    } catch {
      // Reverse pair not available either
    }

    return null;
  }

  /**
   * Get real user fee rates from an authenticated CCXT client.
   * Falls back to null if credentials are not available.
   */
  private userFeesCache = new Map<
    string,
    { fees: { taker: number; maker: number }; timestamp: number }
  >();
  private readonly userFeesCacheTtlMs = 30 * 60 * 1000; // 30 min

  private async getUserFees(
    exchangeType: ExchangeType,
    userId: string,
  ): Promise<{ taker: number; maker: number } | null> {
    const cacheKey = `${userId}:${exchangeType}`;
    const cached = this.userFeesCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.userFeesCacheTtlMs) {
      return cached.fees;
    }

    try {
      const credentials =
        await this.credentialsService.findActiveByUser(userId);
      const cred = credentials.find((c) => c.exchange === exchangeType);
      if (!cred) return null;

      const decrypted =
        this.credentialsService.getDecryptedCredentials(cred);
      const ccxtLib = require('ccxt');

      let client: any;
      switch (exchangeType) {
        case ExchangeType.BINANCE: {
          const config: any = {
            apiKey: decrypted.apiKey,
            secret: decrypted.apiSecret,
            enableRateLimit: true,
          };
          if (this.binanceHostname === 'binance.us') {
            client = new ccxtLib.binanceus(config);
          } else {
            if (this.binanceHostname) config.hostname = this.binanceHostname;
            client = new ccxtLib.binance(config);
          }
          break;
        }
        case ExchangeType.KRAKEN:
          client = new ccxtLib.kraken({
            apiKey: decrypted.apiKey,
            secret: decrypted.apiSecret,
            enableRateLimit: true,
          });
          break;
        default:
          return null;
      }

      // fetchTradingFee returns the user's actual fee tier
      const feeInfo = await client.fetchTradingFee('BTC/USDT');
      const fees = {
        taker: feeInfo.taker ?? 0,
        maker: feeInfo.maker ?? 0,
      };

      this.logger.log(
        `User fees for ${exchangeType}: taker=${fees.taker}, maker=${fees.maker}`,
      );

      this.userFeesCache.set(cacheKey, { fees, timestamp: Date.now() });
      return fees;
    } catch (error) {
      this.logger.debug(
        `Could not fetch user fees for ${exchangeType}: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * Get possible pair symbols trying both USD and USDT variants
   */
  private getPairVariants(
    base: string,
    quote: string,
    markets: Record<string, any>,
  ): string[] {
    const pairs: string[] = [];
    const exact = `${base}/${quote}`;
    if (markets[exact]) pairs.push(exact);

    // Try USD/USDT alternatives
    const alts: Record<string, string> = { USDT: 'USD', USD: 'USDT' };
    if (alts[quote]) {
      const alt = `${base}/${alts[quote]}`;
      if (markets[alt]) pairs.push(alt);
    }
    if (alts[base]) {
      const alt = `${alts[base]}/${quote}`;
      if (markets[alt]) pairs.push(alt);
    }

    return pairs;
  }

  // ── Swap Execution ──────────────────────────────────────────────

  async executeSwap(
    from: string,
    to: string,
    amount: number,
    exchange: string,
    userId: string,
  ): Promise<SwapExecutionResultDto> {
    if (exchange === ExchangeType.NEXO_PRO) {
      return this.executeNexoSwap(from, to, amount, userId);
    }
    return this.executeCcxtSwap(from, to, amount, exchange as ExchangeType, userId);
  }

  private async executeCcxtSwap(
    from: string,
    to: string,
    amount: number,
    exchangeType: ExchangeType,
    userId: string,
  ): Promise<SwapExecutionResultDto> {
    const credentials = await this.credentialsService.findActiveByUser(userId);
    const cred = credentials.find((c) => c.exchange === exchangeType);
    if (!cred) {
      throw new Error(`No credentials found for ${exchangeType}`);
    }

    const decrypted = this.credentialsService.getDecryptedCredentials(cred);
    const ccxtLib = require('ccxt');

    let client: any;
    switch (exchangeType) {
      case ExchangeType.BINANCE: {
        const config: any = {
          apiKey: decrypted.apiKey,
          secret: decrypted.apiSecret,
          enableRateLimit: true,
        };
        if (this.binanceHostname === 'binance.us') {
          client = new ccxtLib.binanceus(config);
        } else {
          if (this.binanceHostname) config.hostname = this.binanceHostname;
          client = new ccxtLib.binance(config);
        }
        break;
      }
      case ExchangeType.KRAKEN:
        client = new ccxtLib.kraken({
          apiKey: decrypted.apiKey,
          secret: decrypted.apiSecret,
          enableRateLimit: true,
        });
        break;
      default:
        throw new Error(`Exchange ${exchangeType} not supported for swap execution`);
    }

    await client.loadMarkets();

    // Try direct pair: FROM/TO → sell FROM
    const directPairs = this.getPairVariants(from, to, client.markets);
    for (const pair of directPairs) {
      if (!client.markets[pair]?.active) continue;
      try {
        const order = await client.createMarketOrder(pair, 'sell', amount);
        return this.mapCcxtOrder(order, exchangeType);
      } catch (error) {
        this.logger.debug(`Direct sell failed on ${pair}: ${error.message}`);
      }
    }

    // Try reverse pair: TO/FROM → buy TO with FROM
    const reversePairs = this.getPairVariants(to, from, client.markets);
    for (const pair of reversePairs) {
      if (!client.markets[pair]?.active) continue;
      try {
        // Use createMarketBuyOrderWithCost to spend exact amount of FROM (quote currency)
        let order: any;
        if (client.has['createMarketBuyOrderWithCost']) {
          order = await client.createMarketBuyOrderWithCost(pair, amount);
        } else {
          // Fallback: estimate base amount from ticker
          const ticker = await client.fetchTicker(pair);
          const ask = ticker.ask || ticker.last;
          const baseAmount = amount / ask;
          order = await client.createMarketOrder(pair, 'buy', baseAmount);
        }
        return this.mapCcxtOrder(order, exchangeType);
      } catch (error) {
        this.logger.debug(`Reverse buy failed on ${pair}: ${error.message}`);
      }
    }

    throw new Error(`No tradeable pair found for ${from}/${to} on ${exchangeType}`);
  }

  private async executeNexoSwap(
    from: string,
    to: string,
    amount: number,
    userId: string,
  ): Promise<SwapExecutionResultDto> {
    const credentials = await this.credentialsService.findActiveByUser(userId);
    const nexoCred = credentials.find(
      (c) => c.exchange === ExchangeType.NEXO_PRO,
    );
    if (!nexoCred) {
      throw new Error('No Nexo Pro credentials found');
    }

    const decrypted = this.credentialsService.getDecryptedCredentials(nexoCred);
    const client = new NexoClient({
      apiKey: decrypted.apiKey,
      apiSecret: decrypted.apiSecret,
    });

    // Try direct pair (sell FROM)
    const directPair = `${from}/${to}`;
    try {
      const result = await client.placeOrder({
        pair: directPair,
        side: 'sell',
        type: 'market',
        quantity: amount.toString(),
      });
      return {
        exchange: ExchangeType.NEXO_PRO,
        orderId: result.orderId,
        pair: directPair,
        side: 'sell',
        status: 'closed',
        amount,
        filled: amount,
        price: 0,
        cost: 0,
        fee: null,
        feeAsset: null,
      };
    } catch {
      // Try reverse pair
    }

    const reversePair = `${to}/${from}`;
    const result = await client.placeOrder({
      pair: reversePair,
      side: 'buy',
      type: 'market',
      quantity: amount.toString(),
    });
    return {
      exchange: ExchangeType.NEXO_PRO,
      orderId: result.orderId,
      pair: reversePair,
      side: 'buy',
      status: 'closed',
      amount,
      filled: amount,
      price: 0,
      cost: 0,
      fee: null,
      feeAsset: null,
    };
  }

  private mapCcxtOrder(order: any, exchange: ExchangeType): SwapExecutionResultDto {
    return {
      exchange,
      orderId: order.id || '',
      pair: order.symbol || '',
      side: order.side || '',
      status: order.status || 'closed',
      amount: order.amount || 0,
      filled: order.filled || 0,
      price: order.average || order.price || 0,
      cost: order.cost || 0,
      fee: order.fee?.cost ?? null,
      feeAsset: order.fee?.currency ?? null,
    };
  }

  private createPublicCcxtClient(exchange: ExchangeType): any | null {
    const ccxtLib = require('ccxt');
    switch (exchange) {
      case ExchangeType.BINANCE: {
        const config: any = { enableRateLimit: true };
        if (this.binanceHostname === 'binance.us') {
          return new ccxtLib.binanceus(config);
        }
        if (this.binanceHostname) {
          config.hostname = this.binanceHostname;
        }
        return new ccxtLib.binance(config);
      }
      case ExchangeType.KRAKEN:
        return new ccxtLib.kraken({ enableRateLimit: true });
      default:
        return null;
    }
  }

  private async loadMarketsWithCache(
    client: any,
    exchange: ExchangeType,
  ): Promise<Record<string, any>> {
    const cached = this.marketsCache.get(exchange);
    if (cached && Date.now() - cached.timestamp < this.marketsCacheTtlMs) {
      return cached.markets;
    }

    await client.loadMarkets();
    this.marketsCache.set(exchange, {
      markets: client.markets,
      timestamp: Date.now(),
    });
    return client.markets;
  }
}
