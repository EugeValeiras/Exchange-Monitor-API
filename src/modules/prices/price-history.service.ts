import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  PriceHistory,
  PriceHistoryDocument,
} from './schemas/price-history.schema';
import { PriceAggregatorService } from './websocket/price-aggregator.service';
import {
  PriceHistoryQueryDto,
  PriceHistoryResponseDto,
  PriceHistoryChartQueryDto,
  PriceHistoryChartResponseDto,
  PriceAtQueryDto,
  PriceAtResponseDto,
  TimeframeEnum,
  ChartDataPointDto,
} from './dto/price-history.dto';

@Injectable()
export class PriceHistoryService {
  private readonly logger = new Logger(PriceHistoryService.name);

  constructor(
    @InjectModel(PriceHistory.name)
    private readonly priceHistoryModel: Model<PriceHistoryDocument>,
    private readonly priceAggregatorService: PriceAggregatorService,
  ) {}

  /**
   * Captures current prices from the WebSocket cache and stores them in the database.
   * Called by the cron job every 5 minutes.
   */
  async captureCurrentPrices(): Promise<number> {
    const prices = this.priceAggregatorService.getAllPrices();

    if (prices.length === 0) {
      this.logger.warn('No prices available to capture');
      return 0;
    }

    const timestamp = new Date();
    // Round to nearest 5 minutes for consistency
    timestamp.setMinutes(Math.floor(timestamp.getMinutes() / 5) * 5);
    timestamp.setSeconds(0);
    timestamp.setMilliseconds(0);

    const documents: Partial<PriceHistory>[] = [];

    for (const aggregatedPrice of prices) {
      // Store price for each exchange separately
      for (const exchangePrice of aggregatedPrice.prices) {
        documents.push({
          symbol: aggregatedPrice.symbol,
          exchange: exchangePrice.exchange,
          price: exchangePrice.price,
          change24h: exchangePrice.change24h,
          timestamp,
        });
      }
    }

    if (documents.length === 0) {
      this.logger.warn('No price documents to insert');
      return 0;
    }

    try {
      // Use insertMany with ordered: false to continue on duplicate key errors
      const result = await this.priceHistoryModel.insertMany(documents, {
        ordered: false,
      });
      this.logger.log(
        `Captured ${result.length} price records at ${timestamp.toISOString()}`,
      );
      return result.length;
    } catch (error) {
      // Handle duplicate key errors gracefully (expected if cron runs multiple times)
      if (error.code === 11000) {
        const insertedCount =
          error.insertedDocs?.length || documents.length - (error.writeErrors?.length || 0);
        this.logger.debug(
          `Inserted ${insertedCount} records, ${error.writeErrors?.length || 0} duplicates skipped`,
        );
        return insertedCount;
      }
      throw error;
    }
  }

  /**
   * Get price history with filters
   */
  async getHistory(query: PriceHistoryQueryDto): Promise<PriceHistoryResponseDto> {
    const { symbol, from, to, exchange, limit = 100 } = query;

    const filter: Record<string, unknown> = { symbol };

    if (exchange) {
      filter.exchange = exchange;
    }

    if (from || to) {
      filter.timestamp = {};
      if (from) {
        (filter.timestamp as Record<string, Date>).$gte = new Date(from);
      }
      if (to) {
        (filter.timestamp as Record<string, Date>).$lte = new Date(to);
      }
    }

    const history = await this.priceHistoryModel
      .find(filter)
      .sort({ timestamp: -1 })
      .limit(Math.min(limit, 1000))
      .lean()
      .exec();

    return {
      symbol,
      history: history.map((h) => ({
        symbol: h.symbol,
        exchange: h.exchange,
        price: h.price,
        change24h: h.change24h,
        timestamp: h.timestamp,
      })),
      count: history.length,
    };
  }

  /**
   * Get chart data for a specific timeframe
   */
  async getChartData(
    query: PriceHistoryChartQueryDto,
  ): Promise<PriceHistoryChartResponseDto> {
    const { symbol, timeframe, exchange } = query;

    const to = new Date();
    const from = this.getFromDate(timeframe);

    const filter: Record<string, unknown> = {
      symbol,
      timestamp: { $gte: from, $lte: to },
    };

    if (exchange) {
      filter.exchange = exchange;
    }

    const history = await this.priceHistoryModel
      .find(filter)
      .sort({ timestamp: 1 })
      .lean()
      .exec();

    // Aggregate by timestamp (average if multiple exchanges)
    const aggregatedData = this.aggregateByTimestamp(history);

    return {
      symbol,
      timeframe,
      data: aggregatedData,
      exchange,
      from,
      to,
    };
  }

  /**
   * Get price at a specific timestamp (closest available)
   */
  async getPriceAt(query: PriceAtQueryDto): Promise<PriceAtResponseDto | null> {
    const { symbol, timestamp, exchange } = query;
    const requestedAt = new Date(timestamp);

    const filter: Record<string, unknown> = {
      symbol,
      timestamp: { $lte: requestedAt },
    };

    if (exchange) {
      filter.exchange = exchange;
    }

    // Find the closest price before or at the requested timestamp
    const price = await this.priceHistoryModel
      .findOne(filter)
      .sort({ timestamp: -1 })
      .lean()
      .exec();

    if (!price) {
      return null;
    }

    return {
      symbol: price.symbol,
      price: price.price,
      exchange: price.exchange,
      timestamp: price.timestamp,
      requestedAt,
    };
  }

  /**
   * Calculate the start date based on timeframe
   */
  private getFromDate(timeframe: TimeframeEnum): Date {
    const now = new Date();

    switch (timeframe) {
      case TimeframeEnum.HOUR_1:
        return new Date(now.getTime() - 60 * 60 * 1000);
      case TimeframeEnum.HOUR_6:
        return new Date(now.getTime() - 6 * 60 * 60 * 1000);
      case TimeframeEnum.HOUR_12:
        return new Date(now.getTime() - 12 * 60 * 60 * 1000);
      case TimeframeEnum.HOUR_24:
        return new Date(now.getTime() - 24 * 60 * 60 * 1000);
      case TimeframeEnum.DAY_7:
        return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      case TimeframeEnum.DAY_30:
        return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      default:
        return new Date(now.getTime() - 24 * 60 * 60 * 1000);
    }
  }

  /**
   * Aggregate prices by timestamp (average prices from multiple exchanges)
   */
  private aggregateByTimestamp(
    history: Array<{
      symbol: string;
      exchange: string;
      price: number;
      change24h?: number;
      timestamp: Date;
    }>,
  ): ChartDataPointDto[] {
    const timestampMap = new Map<
      number,
      { prices: number[]; changes: (number | undefined)[] }
    >();

    for (const record of history) {
      const timeKey = record.timestamp.getTime();
      const existing = timestampMap.get(timeKey);

      if (existing) {
        existing.prices.push(record.price);
        existing.changes.push(record.change24h);
      } else {
        timestampMap.set(timeKey, {
          prices: [record.price],
          changes: [record.change24h],
        });
      }
    }

    const result: ChartDataPointDto[] = [];

    for (const [time, data] of timestampMap.entries()) {
      const avgPrice =
        data.prices.reduce((a, b) => a + b, 0) / data.prices.length;
      const validChanges = data.changes.filter(
        (c): c is number => c !== undefined,
      );
      const avgChange =
        validChanges.length > 0
          ? validChanges.reduce((a, b) => a + b, 0) / validChanges.length
          : undefined;

      result.push({
        time,
        price: avgPrice,
        change24h: avgChange,
      });
    }

    return result.sort((a, b) => a.time - b.time);
  }
}
