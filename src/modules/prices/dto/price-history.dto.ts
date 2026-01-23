import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsDateString, IsEnum } from 'class-validator';
import { Type } from 'class-transformer';

export enum TimeframeEnum {
  HOUR_1 = '1h',
  HOUR_6 = '6h',
  HOUR_12 = '12h',
  HOUR_24 = '24h',
  DAY_7 = '7d',
  DAY_30 = '30d',
  DAY_90 = '90d',
  DAY_180 = '180d',
}

export class PriceHistoryQueryDto {
  @ApiProperty({ example: 'BTC/USDT', description: 'Trading pair symbol' })
  @IsString()
  symbol: string;

  @ApiPropertyOptional({ description: 'Start date for filtering' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: 'End date for filtering' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({
    example: 'binance',
    description: 'Filter by specific exchange',
  })
  @IsOptional()
  @IsString()
  exchange?: string;

  @ApiPropertyOptional({
    example: 100,
    description: 'Limit number of results (default 100)',
  })
  @IsOptional()
  @Type(() => Number)
  limit?: number;
}

export class PriceHistoryChartQueryDto {
  @ApiProperty({ example: 'BTC/USDT', description: 'Trading pair symbol' })
  @IsString()
  symbol: string;

  @ApiProperty({
    enum: TimeframeEnum,
    example: '24h',
    description: 'Timeframe for chart data',
  })
  @IsEnum(TimeframeEnum)
  timeframe: TimeframeEnum;

  @ApiPropertyOptional({
    example: 'binance',
    description: 'Filter by specific exchange',
  })
  @IsOptional()
  @IsString()
  exchange?: string;
}

export class PriceAtQueryDto {
  @ApiProperty({ example: 'BTC/USDT', description: 'Trading pair symbol' })
  @IsString()
  symbol: string;

  @ApiProperty({ description: 'Timestamp to query price at' })
  @IsDateString()
  timestamp: string;

  @ApiPropertyOptional({
    example: 'binance',
    description: 'Filter by specific exchange',
  })
  @IsOptional()
  @IsString()
  exchange?: string;
}

export class PriceHistoryItemDto {
  @ApiProperty({ example: 'BTC/USDT' })
  symbol: string;

  @ApiProperty({ example: 'binance' })
  exchange: string;

  @ApiProperty({ example: 45000.5 })
  price: number;

  @ApiPropertyOptional({ example: 2.5 })
  change24h?: number;

  @ApiProperty()
  timestamp: Date;
}

export class PriceHistoryResponseDto {
  @ApiProperty({ example: 'BTC/USDT' })
  symbol: string;

  @ApiProperty({ type: [PriceHistoryItemDto] })
  history: PriceHistoryItemDto[];

  @ApiProperty({ example: 100 })
  count: number;
}

export class ChartDataPointDto {
  @ApiProperty({ description: 'Unix timestamp in milliseconds' })
  time: number;

  @ApiProperty({ example: 45000.5 })
  price: number;

  @ApiPropertyOptional({ example: 2.5 })
  change24h?: number;
}

export class PriceHistoryChartResponseDto {
  @ApiProperty({ example: 'BTC/USDT' })
  symbol: string;

  @ApiProperty({ enum: TimeframeEnum, example: '24h' })
  timeframe: TimeframeEnum;

  @ApiProperty({ type: [ChartDataPointDto] })
  data: ChartDataPointDto[];

  @ApiPropertyOptional({ example: 'binance' })
  exchange?: string;

  @ApiProperty({ description: 'Start of the timeframe' })
  from: Date;

  @ApiProperty({ description: 'End of the timeframe' })
  to: Date;
}

export class PriceAtResponseDto {
  @ApiProperty({ example: 'BTC/USDT' })
  symbol: string;

  @ApiProperty({ example: 45000.5 })
  price: number;

  @ApiPropertyOptional({ example: 'binance' })
  exchange?: string;

  @ApiProperty({ description: 'Timestamp of the price data' })
  timestamp: Date;

  @ApiProperty({ description: 'Requested timestamp' })
  requestedAt: Date;
}
