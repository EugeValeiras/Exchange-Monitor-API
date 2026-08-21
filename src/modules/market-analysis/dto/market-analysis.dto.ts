import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsEnum } from 'class-validator';
import { Type } from 'class-transformer';

export enum OhlcTimeframe {
  M15 = '15m',
  H1 = '1h',
  H4 = '4h',
  D1 = '1d',
  W1 = '1w',
}

export enum SupportedExchange {
  BINANCE = 'binance',
  KRAKEN = 'kraken',
}

export class OhlcQueryDto {
  @ApiProperty({ enum: SupportedExchange, example: SupportedExchange.BINANCE })
  @IsEnum(SupportedExchange)
  exchange: SupportedExchange;

  @ApiProperty({ example: 'BTC/USDT' })
  @IsString()
  symbol: string;

  @ApiProperty({ enum: OhlcTimeframe, example: OhlcTimeframe.H1 })
  @IsEnum(OhlcTimeframe)
  timeframe: OhlcTimeframe;

  @ApiPropertyOptional({ example: 200, description: 'Number of candles (max 500)' })
  @IsOptional()
  @Type(() => Number)
  limit?: number;
}

export class IndicatorsQueryDto {
  @ApiProperty({ enum: SupportedExchange, example: SupportedExchange.BINANCE })
  @IsEnum(SupportedExchange)
  exchange: SupportedExchange;

  @ApiProperty({ example: 'BTC/USDT' })
  @IsString()
  symbol: string;

  @ApiProperty({ enum: OhlcTimeframe, example: OhlcTimeframe.H1 })
  @IsEnum(OhlcTimeframe)
  timeframe: OhlcTimeframe;

  @ApiPropertyOptional({
    example: 500,
    description:
      'Number of candles (default 200, max 1000). The chart asks for more than it draws so ' +
      'there is history to pan into.',
  })
  @IsOptional()
  @Type(() => Number)
  limit?: number;
}

export class SummaryQueryDto {
  @ApiProperty({ enum: SupportedExchange, example: SupportedExchange.BINANCE })
  @IsEnum(SupportedExchange)
  exchange: SupportedExchange;
}

export class OhlcCandleDto {
  @ApiProperty({ description: 'Unix timestamp (ms)' })
  timestamp: number;

  @ApiProperty() open: number;
  @ApiProperty() high: number;
  @ApiProperty() low: number;
  @ApiProperty() close: number;
  @ApiProperty() volume: number;
}

export class OhlcResponseDto {
  @ApiProperty() exchange: string;
  @ApiProperty() symbol: string;
  @ApiProperty() timeframe: string;
  @ApiProperty({ type: [OhlcCandleDto] }) candles: OhlcCandleDto[];
}

export class IndicatorPointDto {
  @ApiProperty() timestamp: number;
  @ApiPropertyOptional({ nullable: true }) value: number | null;
}

export class MacdPointDto {
  @ApiProperty() timestamp: number;
  @ApiPropertyOptional({ nullable: true }) macd: number | null;
  @ApiPropertyOptional({ nullable: true }) signal: number | null;
  @ApiPropertyOptional({ nullable: true }) histogram: number | null;
}

export class BollingerPointDto {
  @ApiProperty() timestamp: number;
  @ApiPropertyOptional({ nullable: true }) upper: number | null;
  @ApiPropertyOptional({ nullable: true }) middle: number | null;
  @ApiPropertyOptional({ nullable: true }) lower: number | null;
}

export class RsiDivergenceDto {
  @ApiProperty({ enum: ['bullish', 'bearish'] })
  type: 'bullish' | 'bearish';

  @ApiProperty() startIndex: number;
  @ApiProperty() endIndex: number;
  @ApiProperty() startTimestamp: number;
  @ApiProperty() endTimestamp: number;
  @ApiProperty() startPrice: number;
  @ApiProperty() endPrice: number;
  @ApiProperty() startRsi: number;
  @ApiProperty() endRsi: number;
}

export class IndicatorsResponseDto {
  @ApiProperty() exchange: string;
  @ApiProperty() symbol: string;
  @ApiProperty() timeframe: string;
  @ApiProperty({ type: [OhlcCandleDto] }) candles: OhlcCandleDto[];
  @ApiProperty({ type: [IndicatorPointDto] }) rsi: IndicatorPointDto[];
  @ApiProperty({ type: [MacdPointDto] }) macd: MacdPointDto[];
  @ApiProperty({ type: [IndicatorPointDto] }) sma20: IndicatorPointDto[];
  @ApiProperty({ type: [IndicatorPointDto] }) sma50: IndicatorPointDto[];
  @ApiProperty({ type: [IndicatorPointDto] }) ema20: IndicatorPointDto[];
  @ApiProperty({ type: [BollingerPointDto] }) bollinger: BollingerPointDto[];
  @ApiProperty({ type: [RsiDivergenceDto], description: 'Divergencias bullish/bearish detectadas entre RSI(14) y close' })
  rsiDivergences: RsiDivergenceDto[];
}

export class SummaryRowDto {
  @ApiProperty() symbol: string;
  @ApiProperty() price: number;
  @ApiPropertyOptional({ nullable: true }) pctChange1h: number | null;
  @ApiPropertyOptional({ nullable: true }) pctChange24h: number | null;
  @ApiPropertyOptional({ nullable: true }) pctChange7d: number | null;
  @ApiPropertyOptional({ nullable: true }) pctChange30d: number | null;
  @ApiProperty() volume24h: number;
  @ApiProperty({ type: [Number], description: 'Last 24 hourly closes for sparkline' })
  sparkline: number[];
  @ApiPropertyOptional({ nullable: true, description: 'Error message if the fetch failed' })
  error?: string | null;
}

export class SummaryResponseDto {
  @ApiProperty() exchange: string;
  @ApiProperty({ type: [SummaryRowDto] }) rows: SummaryRowDto[];
  @ApiProperty() generatedAt: number;
}
