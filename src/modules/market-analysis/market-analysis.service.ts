import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RSI, MACD, SMA, EMA, BollingerBands } from 'technicalindicators';
import {
  IExchangeAdapter,
  IOHLCVCandle,
} from '../../common/interfaces/exchange-adapter.interface';
import { BinanceAdapter } from '../../integrations/exchanges/binance/binance.adapter';
import { KrakenAdapter } from '../../integrations/exchanges/kraken/kraken.adapter';
import { SettingsService } from '../settings/settings.service';
import {
  IndicatorsResponseDto,
  OhlcResponseDto,
  SummaryResponseDto,
  SummaryRowDto,
  SupportedExchange,
} from './dto/market-analysis.dto';

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

const CANDLE_CACHE_TTL_MS = 60_000;
const SUMMARY_CACHE_TTL_MS = 60_000;
// The summary asks for 745 hourly candles to reach back 30 days. This cap
// used to be 500, which silently truncated the request: `closeAt(24 * 30)`
// then indexed at -221 and `pctChange30d` came back null for every pair, on
// every exchange, always. Binance serves well past this; Kraken tops out at
// 720 per request, so on Kraken the 30d column stays null by the exchange's
// own limit rather than by ours.
const MAX_OHLC_LIMIT = 1000;
const SUMMARY_LIMIT = 745; // 745 hourly candles ≈ 31 days

@Injectable()
export class MarketAnalysisService {
  private readonly logger = new Logger(MarketAnalysisService.name);
  private readonly adapters = new Map<SupportedExchange, IExchangeAdapter>();
  private readonly ohlcCache = new Map<string, CacheEntry<IOHLCVCandle[]>>();
  private readonly summaryCache = new Map<string, CacheEntry<SummaryResponseDto>>();

  constructor(
    private readonly configService: ConfigService,
    private readonly settingsService: SettingsService,
  ) {}

  async getOHLCV(
    exchange: SupportedExchange,
    symbol: string,
    timeframe: string,
    limit?: number,
  ): Promise<OhlcResponseDto> {
    const candles = await this.fetchOHLCVCached(exchange, symbol, timeframe, limit);
    return { exchange, symbol, timeframe, candles };
  }

  async getIndicators(
    exchange: SupportedExchange,
    symbol: string,
    timeframe: string,
    limit?: number,
  ): Promise<IndicatorsResponseDto> {
    const candles = await this.fetchOHLCVCached(exchange, symbol, timeframe, limit ?? 200);
    const closes = candles.map((c) => c.close);
    const timestamps = candles.map((c) => c.timestamp);

    const rsiValues = RSI.calculate({ values: closes, period: 14 });
    const macdValues = MACD.calculate({
      values: closes,
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
      SimpleMAOscillator: false,
      SimpleMASignal: false,
    });
    const sma20Values = SMA.calculate({ values: closes, period: 20 });
    const sma50Values = SMA.calculate({ values: closes, period: 50 });
    const ema20Values = EMA.calculate({ values: closes, period: 20 });
    const bbValues = BollingerBands.calculate({
      values: closes,
      period: 20,
      stdDev: 2,
    });

    const alignNumeric = (values: number[]) =>
      alignToTimestamps(timestamps, values, (v) => ({ value: v }));

    const rsiAligned = alignNumeric(rsiValues);

    return {
      exchange,
      symbol,
      timeframe,
      candles,
      rsi: rsiAligned,
      macd: alignToTimestamps(timestamps, macdValues, (v) => ({
        macd: v.MACD ?? null,
        signal: v.signal ?? null,
        histogram: v.histogram ?? null,
      })),
      sma20: alignNumeric(sma20Values),
      sma50: alignNumeric(sma50Values),
      ema20: alignNumeric(ema20Values),
      bollinger: alignToTimestamps(timestamps, bbValues, (v) => ({
        upper: v.upper ?? null,
        middle: v.middle ?? null,
        lower: v.lower ?? null,
      })),
      rsiDivergences: [],
    };
  }

  async getMarketSummary(
    userId: string,
    exchange: SupportedExchange,
  ): Promise<SummaryResponseDto> {
    const cacheKey = `${userId}:${exchange}`;
    const cached = this.summaryCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const symbols = await this.settingsService.getSymbolsForExchange(userId, exchange);

    const rows = await Promise.all(
      symbols.map((symbol) => this.buildSummaryRow(exchange, symbol)),
    );

    const response: SummaryResponseDto = {
      exchange,
      rows,
      generatedAt: Date.now(),
    };

    this.summaryCache.set(cacheKey, {
      value: response,
      expiresAt: Date.now() + SUMMARY_CACHE_TTL_MS,
    });

    return response;
  }

  private async buildSummaryRow(
    exchange: SupportedExchange,
    symbol: string,
  ): Promise<SummaryRowDto> {
    try {
      const candles = await this.fetchOHLCVCached(exchange, symbol, '1h', SUMMARY_LIMIT);
      if (candles.length === 0) {
        return emptyRow(symbol, 'no candles returned');
      }

      const last = candles[candles.length - 1];
      const closeAt = (offsetHours: number): number | null => {
        const idx = candles.length - 1 - offsetHours;
        return idx >= 0 ? candles[idx].close : null;
      };

      const pct = (older: number | null): number | null => {
        if (older === null || older === 0) return null;
        return ((last.close - older) / older) * 100;
      };

      const sparklineRaw = candles.slice(-24).map((c) => c.close);
      const volume24h = candles.slice(-24).reduce((sum, c) => sum + c.volume, 0);

      return {
        symbol,
        price: last.close,
        pctChange1h: pct(closeAt(1)),
        pctChange24h: pct(closeAt(24)),
        pctChange7d: pct(closeAt(24 * 7)),
        pctChange30d: pct(closeAt(24 * 30)),
        volume24h,
        sparkline: sparklineRaw,
        error: null,
      };
    } catch (error) {
      this.logger.warn(
        `Failed to build summary row for ${exchange} ${symbol}: ${(error as Error).message}`,
      );
      return emptyRow(symbol, (error as Error).message);
    }
  }

  private async fetchOHLCVCached(
    exchange: SupportedExchange,
    symbol: string,
    timeframe: string,
    limit?: number,
  ): Promise<IOHLCVCandle[]> {
    const effectiveLimit = Math.min(limit ?? 200, MAX_OHLC_LIMIT);
    const cacheKey = `${exchange}:${symbol}:${timeframe}:${effectiveLimit}`;
    const cached = this.ohlcCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const adapter = this.getAdapter(exchange);
    if (!adapter.fetchOHLCV) {
      throw new BadRequestException(
        `Exchange ${exchange} does not support OHLCV fetching`,
      );
    }
    const candles = await adapter.fetchOHLCV(symbol, timeframe, effectiveLimit);
    this.ohlcCache.set(cacheKey, {
      value: candles,
      expiresAt: Date.now() + CANDLE_CACHE_TTL_MS,
    });
    return candles;
  }

  private getAdapter(exchange: SupportedExchange): IExchangeAdapter {
    let adapter = this.adapters.get(exchange);
    if (adapter) return adapter;

    // Public OHLCV does not require API credentials. Pass empty strings to
    // bootstrap a ccxt client that can still hit public endpoints.
    if (exchange === SupportedExchange.BINANCE) {
      const hostname = this.configService.get<string>('BINANCE_HOSTNAME');
      adapter = new BinanceAdapter('', '', hostname);
    } else if (exchange === SupportedExchange.KRAKEN) {
      adapter = new KrakenAdapter('', '');
    } else {
      throw new BadRequestException(`Unsupported exchange: ${exchange}`);
    }

    this.adapters.set(exchange, adapter);
    return adapter;
  }
}

function emptyRow(symbol: string, error: string): SummaryRowDto {
  return {
    symbol,
    price: 0,
    pctChange1h: null,
    pctChange24h: null,
    pctChange7d: null,
    pctChange30d: null,
    volume24h: 0,
    sparkline: [],
    error,
  };
}

function alignToTimestamps<TIn, TOut extends Record<string, unknown>>(
  timestamps: number[],
  values: TIn[],
  map: (value: TIn) => TOut,
): Array<{ timestamp: number } & TOut> {
  const offset = timestamps.length - values.length;
  return values.map((v, i) => ({
    timestamp: timestamps[i + offset] ?? 0,
    ...map(v),
  }));
}

