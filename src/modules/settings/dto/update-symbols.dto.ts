import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsString } from 'class-validator';

// DEPRECATED - kept for backward compatibility
export class UpdatePricingSymbolsDto {
  @ApiProperty({
    type: [String],
    example: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
    description: 'List of trading pairs to monitor for pricing',
  })
  @IsArray()
  @IsString({ each: true })
  symbols: string[];
}

// DEPRECATED - kept for backward compatibility
export class PricingSymbolsResponseDto {
  @ApiProperty({
    type: [String],
    example: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
  })
  symbols: string[];
}

// NEW - Update symbols for a specific exchange
export class UpdateExchangeSymbolsDto {
  @ApiProperty({
    type: [String],
    example: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
    description: 'List of trading pairs for this exchange',
  })
  @IsArray()
  @IsString({ each: true })
  symbols: string[];
}

// NEW - Response for single exchange symbols
export class ExchangeSymbolsResponseDto {
  @ApiProperty({ example: 'binance' })
  exchange: string;

  @ApiProperty({
    type: [String],
    example: ['BTC/USDT', 'ETH/USDT'],
  })
  symbols: string[];
}

// NEW - Response for all symbols grouped by exchange
export class AllSymbolsResponseDto {
  @ApiProperty({
    type: Object,
    example: {
      binance: ['BTC/USDT', 'ETH/USDT'],
      kraken: ['BTC/USD', 'ETH/USD'],
    },
  })
  symbolsByExchange: Record<string, string[]>;
}
