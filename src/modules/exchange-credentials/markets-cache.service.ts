import { Injectable, Logger } from '@nestjs/common';
import * as ccxt from 'ccxt';
import { ExchangeType } from '../../common/constants/exchanges.constant';
import { AvailableSymbolDto } from './dto/available-symbols.dto';

interface CacheEntry {
  symbols: AvailableSymbolDto[];
  cachedAt: Date;
}

@Injectable()
export class MarketsCacheService {
  private readonly logger = new Logger(MarketsCacheService.name);
  private cache = new Map<string, CacheEntry>();
  private readonly TTL_MS = 5 * 60 * 1000; // 5 minutes

  async getAvailableSymbols(
    exchange: ExchangeType,
    search?: string,
  ): Promise<{ symbols: AvailableSymbolDto[]; cachedAt: Date }> {
    const cached = this.cache.get(exchange);

    if (cached && Date.now() - cached.cachedAt.getTime() < this.TTL_MS) {
      return {
        symbols: this.filterSymbols(cached.symbols, search),
        cachedAt: cached.cachedAt,
      };
    }

    const symbols = await this.fetchSymbolsFromExchange(exchange);
    const cachedAt = new Date();

    this.cache.set(exchange, { symbols, cachedAt });

    return {
      symbols: this.filterSymbols(symbols, search),
      cachedAt,
    };
  }

  private async fetchSymbolsFromExchange(
    exchange: ExchangeType,
  ): Promise<AvailableSymbolDto[]> {
    const client = this.createPublicClient(exchange);

    if (!client) {
      this.logger.warn(`No public client available for ${exchange}`);
      return [];
    }

    try {
      this.logger.log(`Fetching markets from ${exchange}...`);
      await client.loadMarkets();

      const symbols: AvailableSymbolDto[] = [];

      for (const symbol of client.symbols) {
        // Only include USDT and USD pairs
        if (!symbol.endsWith('/USDT') && !symbol.endsWith('/USD')) {
          continue;
        }

        const market = client.markets[symbol];
        if (!market || !market.active) {
          continue;
        }

        // Normalize Kraken symbols (XBT -> BTC)
        const normalizedSymbol = this.normalizeSymbol(symbol, exchange);
        const [base, quote] = normalizedSymbol.split('/');

        symbols.push({
          symbol: normalizedSymbol,
          base,
          quote,
        });
      }

      // Sort alphabetically by base
      symbols.sort((a, b) => a.base.localeCompare(b.base));

      this.logger.log(`Fetched ${symbols.length} symbols from ${exchange}`);
      return symbols;
    } catch (error) {
      this.logger.error(`Failed to fetch markets from ${exchange}: ${error.message}`);
      return [];
    }
  }

  private createPublicClient(exchange: ExchangeType): ccxt.Exchange | null {
    switch (exchange) {
      case ExchangeType.BINANCE:
        return new ccxt.binance({ enableRateLimit: true });
      case ExchangeType.KRAKEN:
        return new ccxt.kraken({ enableRateLimit: true });
      default:
        return null;
    }
  }

  private normalizeSymbol(symbol: string, exchange: ExchangeType): string {
    if (exchange === ExchangeType.KRAKEN) {
      // Kraken uses XBT instead of BTC, XDG instead of DOGE
      return symbol
        .replace('XBT/', 'BTC/')
        .replace('XDG/', 'DOGE/')
        .replace('/USD', '/USDT'); // Normalize to USDT
    }
    return symbol;
  }

  private filterSymbols(
    symbols: AvailableSymbolDto[],
    search?: string,
  ): AvailableSymbolDto[] {
    if (!search) {
      return symbols;
    }

    const searchUpper = search.toUpperCase();
    return symbols.filter(
      (s) =>
        s.symbol.toUpperCase().includes(searchUpper) ||
        s.base.toUpperCase().includes(searchUpper),
    );
  }

  clearCache(): void {
    this.cache.clear();
    this.logger.log('Markets cache cleared');
  }
}
