import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  PriceHistory,
  PriceHistoryDocument,
} from './schemas/price-history.schema';
import { SettingsService } from '../settings/settings.service';

interface BinanceKline {
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  closeTime: number;
}

interface KrakenOHLC {
  time: number;
  open: string;
  high: string;
  low: string;
  close: string;
  vwap: string;
  volume: string;
  count: number;
}

export interface InitializationResult {
  exchange: string;
  symbol: string;
  inserted: number;
  skipped: number;
  error?: string;
}

export interface InitializationSummary {
  totalSymbols: number;
  totalInserted: number;
  totalSkipped: number;
  errors: number;
  results: InitializationResult[];
  duration: number;
}

@Injectable()
export class PriceHistoryInitializerService {
  private readonly logger = new Logger(PriceHistoryInitializerService.name);

  // Binance kline interval: 5m for 5 minutes
  private readonly BINANCE_INTERVAL = '5m';
  // Kraken OHLC interval: 5 for 5 minutes
  private readonly KRAKEN_INTERVAL = 5;

  constructor(
    @InjectModel(PriceHistory.name)
    private readonly priceHistoryModel: Model<PriceHistoryDocument>,
    private readonly settingsService: SettingsService,
  ) {}

  /**
   * Initialize historical price data for all configured symbols
   * @param days Number of days to fetch (default: 7, max: 180)
   */
  async initializeHistoricalData(days = 7): Promise<InitializationSummary> {
    const startTime = Date.now();
    const results: InitializationResult[] = [];

    // Limit to 180 days
    const daysToFetch = Math.min(days, 180);

    this.logger.log(
      `Starting historical price initialization for ${daysToFetch} days...`,
    );

    // Get all configured symbols by exchange
    const symbolsByExchange =
      await this.settingsService.getAllConfiguredSymbolsByExchange();

    // Process Binance symbols
    if (symbolsByExchange['binance']?.length > 0) {
      const binanceResults = await this.initializeBinanceData(
        symbolsByExchange['binance'],
        daysToFetch,
      );
      results.push(...binanceResults);
    }

    // Process Kraken symbols
    if (symbolsByExchange['kraken']?.length > 0) {
      const krakenResults = await this.initializeKrakenData(
        symbolsByExchange['kraken'],
        daysToFetch,
      );
      results.push(...krakenResults);
    }

    const summary: InitializationSummary = {
      totalSymbols: results.length,
      totalInserted: results.reduce((acc, r) => acc + r.inserted, 0),
      totalSkipped: results.reduce((acc, r) => acc + r.skipped, 0),
      errors: results.filter((r) => r.error).length,
      results,
      duration: Date.now() - startTime,
    };

    this.logger.log(
      `Initialization complete: ${summary.totalInserted} records inserted, ` +
        `${summary.totalSkipped} skipped, ${summary.errors} errors in ${summary.duration}ms`,
    );

    return summary;
  }

  /**
   * Fetch and store historical data from Binance
   */
  private async initializeBinanceData(
    symbols: string[],
    days: number,
  ): Promise<InitializationResult[]> {
    const results: InitializationResult[] = [];
    const endTime = Date.now();
    const startTime = endTime - days * 24 * 60 * 60 * 1000;

    for (const symbol of symbols) {
      try {
        const result = await this.fetchBinanceKlines(
          symbol,
          startTime,
          endTime,
        );
        results.push(result);

        // Rate limiting: wait 100ms between requests
        await this.delay(100);
      } catch (error) {
        this.logger.error(
          `Failed to fetch Binance data for ${symbol}: ${error.message}`,
        );
        results.push({
          exchange: 'binance',
          symbol,
          inserted: 0,
          skipped: 0,
          error: error.message,
        });
      }
    }

    return results;
  }

  /**
   * Fetch klines from Binance API and store in database
   */
  private async fetchBinanceKlines(
    symbol: string,
    startTime: number,
    endTime: number,
  ): Promise<InitializationResult> {
    // Convert symbol format: BTC/USDT -> BTCUSDT
    const binanceSymbol = symbol.replace('/', '');

    // Binance API limits to 1000 klines per request
    // 5-minute intervals: 1000 * 5min = ~3.47 days per request
    const allKlines: BinanceKline[] = [];
    let currentStart = startTime;

    while (currentStart < endTime) {
      const url = new URL('https://api.binance.com/api/v3/klines');
      url.searchParams.set('symbol', binanceSymbol);
      url.searchParams.set('interval', this.BINANCE_INTERVAL);
      url.searchParams.set('startTime', currentStart.toString());
      url.searchParams.set('endTime', endTime.toString());
      url.searchParams.set('limit', '1000');

      const response = await fetch(url.toString());

      if (!response.ok) {
        throw new Error(`Binance API error: ${response.status}`);
      }

      const data = await response.json();

      if (!Array.isArray(data) || data.length === 0) {
        break;
      }

      // Parse Binance kline response
      const klines: BinanceKline[] = data.map((k: unknown[]) => ({
        openTime: k[0] as number,
        open: k[1] as string,
        high: k[2] as string,
        low: k[3] as string,
        close: k[4] as string,
        volume: k[5] as string,
        closeTime: k[6] as number,
      }));

      allKlines.push(...klines);

      // Move to next batch
      const lastKline = klines[klines.length - 1];
      currentStart = lastKline.closeTime + 1;

      // Rate limit
      await this.delay(50);
    }

    // Store in database
    return this.storeKlines(symbol, 'binance', allKlines);
  }

  /**
   * Store klines in the database
   */
  private async storeKlines(
    symbol: string,
    exchange: string,
    klines: BinanceKline[],
  ): Promise<InitializationResult> {
    if (klines.length === 0) {
      return { exchange, symbol, inserted: 0, skipped: 0 };
    }

    const documents = klines.map((k) => ({
      symbol,
      exchange,
      price: parseFloat(k.close),
      timestamp: new Date(k.openTime),
    }));

    try {
      const result = await this.priceHistoryModel.insertMany(documents, {
        ordered: false,
      });

      this.logger.debug(
        `${exchange}/${symbol}: inserted ${result.length} records`,
      );

      return {
        exchange,
        symbol,
        inserted: result.length,
        skipped: documents.length - result.length,
      };
    } catch (error) {
      if (error.code === 11000) {
        // Duplicate key errors - some records were inserted
        const insertedCount = error.insertedDocs?.length || 0;
        const skippedCount = documents.length - insertedCount;

        this.logger.debug(
          `${exchange}/${symbol}: inserted ${insertedCount}, skipped ${skippedCount} duplicates`,
        );

        return {
          exchange,
          symbol,
          inserted: insertedCount,
          skipped: skippedCount,
        };
      }
      throw error;
    }
  }

  /**
   * Fetch and store historical data from Kraken
   */
  private async initializeKrakenData(
    symbols: string[],
    days: number,
  ): Promise<InitializationResult[]> {
    const results: InitializationResult[] = [];
    const since = Math.floor((Date.now() - days * 24 * 60 * 60 * 1000) / 1000);

    for (const symbol of symbols) {
      try {
        const result = await this.fetchKrakenOHLC(symbol, since);
        results.push(result);

        // Rate limiting: wait 200ms between requests (Kraken is stricter)
        await this.delay(200);
      } catch (error) {
        this.logger.error(
          `Failed to fetch Kraken data for ${symbol}: ${error.message}`,
        );
        results.push({
          exchange: 'kraken',
          symbol,
          inserted: 0,
          skipped: 0,
          error: error.message,
        });
      }
    }

    return results;
  }

  /**
   * Fetch OHLC from Kraken API and store in database
   */
  private async fetchKrakenOHLC(
    symbol: string,
    since: number,
  ): Promise<InitializationResult> {
    // Convert symbol format: BTC/USD -> XBTUSD
    const krakenSymbol = this.convertToKrakenSymbol(symbol);

    const url = new URL('https://api.kraken.com/0/public/OHLC');
    url.searchParams.set('pair', krakenSymbol);
    url.searchParams.set('interval', this.KRAKEN_INTERVAL.toString());
    url.searchParams.set('since', since.toString());

    const response = await fetch(url.toString());

    if (!response.ok) {
      throw new Error(`Kraken API error: ${response.status}`);
    }

    const data = await response.json();

    if (data.error && data.error.length > 0) {
      throw new Error(`Kraken API error: ${data.error.join(', ')}`);
    }

    // Find the result key (Kraken uses different pair names)
    const resultKey = Object.keys(data.result).find((k) => k !== 'last');
    if (!resultKey) {
      return { exchange: 'kraken', symbol, inserted: 0, skipped: 0 };
    }

    const ohlcData = data.result[resultKey] as unknown[][];

    const documents = ohlcData.map((k) => ({
      symbol,
      exchange: 'kraken',
      price: parseFloat(k[4] as string), // close price
      timestamp: new Date((k[0] as number) * 1000),
    }));

    return this.storeKrakenData(symbol, documents);
  }

  /**
   * Store Kraken OHLC data in the database
   */
  private async storeKrakenData(
    symbol: string,
    documents: Array<{
      symbol: string;
      exchange: string;
      price: number;
      timestamp: Date;
    }>,
  ): Promise<InitializationResult> {
    if (documents.length === 0) {
      return { exchange: 'kraken', symbol, inserted: 0, skipped: 0 };
    }

    try {
      const result = await this.priceHistoryModel.insertMany(documents, {
        ordered: false,
      });

      this.logger.debug(`kraken/${symbol}: inserted ${result.length} records`);

      return {
        exchange: 'kraken',
        symbol,
        inserted: result.length,
        skipped: documents.length - result.length,
      };
    } catch (error) {
      if (error.code === 11000) {
        const insertedCount = error.insertedDocs?.length || 0;
        const skippedCount = documents.length - insertedCount;

        this.logger.debug(
          `kraken/${symbol}: inserted ${insertedCount}, skipped ${skippedCount} duplicates`,
        );

        return {
          exchange: 'kraken',
          symbol,
          inserted: insertedCount,
          skipped: skippedCount,
        };
      }
      throw error;
    }
  }

  /**
   * Convert standard symbol to Kraken format
   */
  private convertToKrakenSymbol(symbol: string): string {
    const [base, quote] = symbol.split('/');

    // Kraken uses XBT instead of BTC
    const krakenBase = base === 'BTC' ? 'XBT' : base;

    // Common quote currency mappings
    const krakenQuote = quote === 'USDT' ? 'USDT' : quote;

    return `${krakenBase}${krakenQuote}`;
  }

  /**
   * Utility delay function
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get current data statistics
   */
  async getStatistics(): Promise<{
    totalRecords: number;
    byExchange: Record<string, number>;
    bySymbol: Record<string, number>;
    oldestRecord: Date | null;
    newestRecord: Date | null;
  }> {
    const [totalRecords, byExchange, bySymbol, oldest, newest] =
      await Promise.all([
        this.priceHistoryModel.countDocuments(),
        this.priceHistoryModel.aggregate([
          { $group: { _id: '$exchange', count: { $sum: 1 } } },
        ]),
        this.priceHistoryModel.aggregate([
          { $group: { _id: '$symbol', count: { $sum: 1 } } },
        ]),
        this.priceHistoryModel.findOne().sort({ timestamp: 1 }).lean(),
        this.priceHistoryModel.findOne().sort({ timestamp: -1 }).lean(),
      ]);

    return {
      totalRecords,
      byExchange: Object.fromEntries(
        byExchange.map((e) => [e._id, e.count]),
      ),
      bySymbol: Object.fromEntries(bySymbol.map((s) => [s._id, s.count])),
      oldestRecord: oldest?.timestamp || null,
      newestRecord: newest?.timestamp || null,
    };
  }
}
