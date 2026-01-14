import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model, Types } from 'mongoose';
import {
  PricingSettings,
  PricingSettingsDocument,
} from './schemas/pricing-settings.schema';

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(
    @InjectModel(PricingSettings.name)
    private settingsModel: Model<PricingSettingsDocument>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async getSymbols(userId: string): Promise<string[]> {
    const settings = await this.settingsModel.findOne({
      userId: new Types.ObjectId(userId),
    });

    return settings?.symbols || [];
  }

  async updateSymbols(userId: string, symbols: string[]): Promise<string[]> {
    const result = await this.settingsModel.findOneAndUpdate(
      { userId: new Types.ObjectId(userId) },
      { $set: { symbols } },
      { upsert: true, new: true },
    );

    this.logger.log(
      `Updated symbols for user ${userId}: ${symbols.length} symbols`,
    );

    // Emit event to notify WebSocket services to refresh subscriptions
    this.eventEmitter.emit('settings.symbols.updated', {
      userId,
      symbols,
    });

    return result.symbols;
  }

  async getAllConfiguredSymbols(): Promise<string[]> {
    const allSettings = await this.settingsModel.find({
      symbols: { $exists: true, $ne: [] },
    });

    const allSymbols = new Set<string>();
    for (const settings of allSettings) {
      settings.symbols.forEach((s) => allSymbols.add(s));
    }

    return Array.from(allSymbols);
  }

  async getConfiguredSymbolsSet(): Promise<Set<string>> {
    const symbols = await this.getAllConfiguredSymbols();
    return new Set(symbols);
  }

  async getConfiguredBaseAssets(): Promise<Set<string>> {
    const symbols = await this.getAllConfiguredSymbols();
    const baseAssets = new Set<string>();

    for (const symbol of symbols) {
      const base = symbol.split('/')[0];
      baseAssets.add(base);
    }

    return baseAssets;
  }

  // ============ NEW: Per-Exchange Methods ============

  /**
   * Get symbols for a specific exchange
   */
  async getSymbolsForExchange(userId: string, exchange: string): Promise<string[]> {
    const settings = await this.settingsModel.findOne({
      userId: new Types.ObjectId(userId),
    });
    return settings?.symbolsByExchange?.[exchange] || [];
  }

  /**
   * Update symbols for a specific exchange
   */
  async updateSymbolsForExchange(
    userId: string,
    exchange: string,
    symbols: string[],
  ): Promise<string[]> {
    const result = await this.settingsModel.findOneAndUpdate(
      { userId: new Types.ObjectId(userId) },
      { $set: { [`symbolsByExchange.${exchange}`]: symbols } },
      { upsert: true, new: true },
    );

    this.logger.log(
      `Updated ${exchange} symbols for user ${userId}: ${symbols.length} symbols`,
    );

    this.eventEmitter.emit('settings.symbols.updated', {
      userId,
      exchange,
      symbols,
    });

    return result.symbolsByExchange?.[exchange] || [];
  }

  /**
   * Get all symbols grouped by exchange for a user
   */
  async getAllSymbolsByExchange(userId: string): Promise<Record<string, string[]>> {
    const settings = await this.settingsModel.findOne({
      userId: new Types.ObjectId(userId),
    });
    return settings?.symbolsByExchange || {};
  }

  /**
   * Get all configured symbols from all users, grouped by exchange
   * Used by PriceAggregatorService
   */
  async getAllConfiguredSymbolsByExchange(): Promise<Record<string, string[]>> {
    const allSettings = await this.settingsModel.find({});
    const result: Record<string, Set<string>> = {};

    for (const settings of allSettings) {
      if (settings.symbolsByExchange) {
        for (const [exchange, symbols] of Object.entries(settings.symbolsByExchange)) {
          if (!result[exchange]) {
            result[exchange] = new Set();
          }
          symbols.forEach((s) => result[exchange].add(s));
        }
      }
    }

    return Object.fromEntries(
      Object.entries(result).map(([k, v]) => [k, Array.from(v)]),
    );
  }

  /**
   * Get base assets for a specific exchange
   */
  async getConfiguredBaseAssetsForExchange(
    userId: string,
    exchange: string,
  ): Promise<Set<string>> {
    const symbols = await this.getSymbolsForExchange(userId, exchange);
    const baseAssets = new Set<string>();

    for (const symbol of symbols) {
      const base = symbol.split('/')[0];
      baseAssets.add(base);
    }

    return baseAssets;
  }
}
