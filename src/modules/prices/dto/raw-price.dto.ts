import { ApiProperty } from '@nestjs/swagger';
import { ExchangeType } from '../../../common/constants/exchanges.constant';

export type RawSource = 'public' | 'authenticated';

export class RawTickerResponseDto {
  @ApiProperty({ enum: ExchangeType, example: 'binance' })
  exchange: ExchangeType;

  @ApiProperty({ example: 'BTC/USDT' })
  symbol: string;

  @ApiProperty({ example: '2026-04-20T12:00:00.000Z' })
  timestamp: Date;

  @ApiProperty({ required: false, nullable: true })
  datetime: string | null;

  @ApiProperty({ required: false, nullable: true, example: 66000 })
  last: number | null;

  @ApiProperty({ required: false, nullable: true })
  close: number | null;

  @ApiProperty({ required: false, nullable: true })
  open: number | null;

  @ApiProperty({ required: false, nullable: true })
  high: number | null;

  @ApiProperty({ required: false, nullable: true })
  low: number | null;

  @ApiProperty({ required: false, nullable: true })
  bid: number | null;

  @ApiProperty({ required: false, nullable: true })
  ask: number | null;

  @ApiProperty({ required: false, nullable: true })
  bidVolume: number | null;

  @ApiProperty({ required: false, nullable: true })
  askVolume: number | null;

  @ApiProperty({ required: false, nullable: true })
  vwap: number | null;

  @ApiProperty({ required: false, nullable: true })
  baseVolume: number | null;

  @ApiProperty({ required: false, nullable: true })
  quoteVolume: number | null;

  @ApiProperty({ required: false, nullable: true })
  change: number | null;

  @ApiProperty({ required: false, nullable: true })
  percentage: number | null;

  @ApiProperty({ enum: ['public', 'authenticated'], example: 'public' })
  source: RawSource;

  @ApiProperty({ description: 'Raw exchange response (CCXT info passthrough)' })
  info: unknown;
}

export class RawOrderbookResponseDto {
  @ApiProperty({ enum: ExchangeType, example: 'binance' })
  exchange: ExchangeType;

  @ApiProperty({ example: 'BTC/USDT' })
  symbol: string;

  @ApiProperty()
  timestamp: Date;

  @ApiProperty({ required: false, nullable: true })
  datetime: string | null;

  @ApiProperty({ required: false, nullable: true })
  nonce: number | null;

  @ApiProperty({
    description: '[[price, amount], ...], highest bid first',
    example: [[66000, 0.5], [65999.5, 1.2]],
  })
  bids: [number, number][];

  @ApiProperty({
    description: '[[price, amount], ...], lowest ask first',
    example: [[66001, 0.3], [66001.5, 0.8]],
  })
  asks: [number, number][];

  @ApiProperty({ enum: ['public', 'authenticated'], example: 'public' })
  source: RawSource;
}
