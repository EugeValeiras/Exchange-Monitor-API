import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString } from 'class-validator';
import { Type } from 'class-transformer';

export class PairTradesQueryDto {
  @ApiProperty({ example: 'BTC/USDT' })
  @IsString()
  pair: string;

  @ApiPropertyOptional({
    example: 1735689600000,
    description:
      'Start of the visible range, epoch ms. Only filters the returned trades',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  from?: number;

  @ApiPropertyOptional({
    example: 1767225600000,
    description: 'End of the visible range, epoch ms',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  to?: number;
}

export class PairTradeDto {
  @ApiProperty() id: string;
  @ApiProperty() exchange: string;
  @ApiProperty({ example: 'BTC/USDT' }) pair: string;
  @ApiProperty({ example: 'buy', enum: ['buy', 'sell'] }) side: string;
  @ApiProperty({
    example: 0.0125,
    description: 'Base asset amount, always positive',
  })
  amount: number;
  @ApiProperty({ example: 57800 }) price: number;
  @ApiProperty({
    example: 722.5,
    description: 'amount * price in the quote asset',
  })
  total: number;
  @ApiPropertyOptional({ example: 0.72 }) fee?: number;
  @ApiPropertyOptional({ example: 'USDT' }) feeAsset?: string;
  @ApiProperty() timestamp: Date;
}

export class PairPositionDto {
  @ApiProperty({
    example: 0.0461,
    description: 'Base asset still held from these trades',
  })
  netAmount: number;

  @ApiProperty({
    example: 59933.45,
    description:
      'Weighted moving average cost of the open position. 0 when flat',
  })
  avgEntryPrice: number;

  @ApiProperty({
    example: 2762.93,
    description: 'Cost of the open position in the quote asset',
  })
  costBasis: number;

  @ApiProperty({
    example: 178.94,
    description:
      'Realized P&L of the closed part, against the average cost at each sale',
  })
  realizedPnl: number;

  @ApiProperty({ example: 0.0541 }) totalBought: number;
  @ApiProperty({ example: 0.008 }) totalSold: number;
  @ApiProperty({
    example: 5,
    description: 'Trades on this pair, across the whole history',
  })
  tradeCount: number;
}

export class CrossTradeBookingDto {
  @ApiProperty({
    example: 'buy',
    enum: ['buy', 'sell'],
    description:
      'What the trade did to the BASE asset of the requested pair. Selling ' +
      'NEXO for BTC is a buy of BTC',
  })
  side: string;

  @ApiProperty({
    example: 0.0112,
    description: 'Amount of the base asset that moved',
  })
  amount: number;

  @ApiProperty({
    example: 63258.77,
    nullable: true,
    description:
      'USD price per unit the P&L module booked it at (the historical ' +
      'price of the base asset that day). null when the P&L never booked ' +
      'it, e.g. no historical price was available',
  })
  usdPrice: number | null;

  @ApiProperty({ example: 706.2, nullable: true }) usdTotal: number | null;

  @ApiProperty({
    example: 'lot',
    enum: ['lot', 'realized', 'none'],
    description:
      'Where the USD figure comes from: the cost-basis lot it opened, the ' +
      'realized P&L record it wrote, or nothing',
  })
  source: string;
}

export class CrossTradeDto {
  @ApiProperty() id: string;
  @ApiProperty() exchange: string;
  @ApiProperty({ example: 'NEXO/BTC' }) pair: string;
  @ApiProperty({ example: 'NEXO', description: 'Asset the trade is stored under' })
  asset: string;
  @ApiProperty({ example: 'sell', enum: ['buy', 'sell'] }) side: string;
  @ApiProperty({ example: 915.2, description: 'Amount of `asset`, positive' })
  amount: number;
  @ApiProperty({ example: 0.0000122, description: 'Price in `priceAsset`' })
  price: number;
  @ApiProperty({ example: 'BTC' }) priceAsset: string;
  @ApiPropertyOptional({ example: 0.00001 }) fee?: number;
  @ApiPropertyOptional({ example: 'BTC' }) feeAsset?: string;
  @ApiProperty() timestamp: Date;

  @ApiProperty({
    type: CrossTradeBookingDto,
    description: 'The same trade, transcribed into the base asset in USD',
  })
  base: CrossTradeBookingDto;
}

export class PairTradesDto {
  @ApiProperty({ example: 'BTC/USDT' }) pair: string;

  @ApiProperty({
    example: ['BTC/USDT', 'BTC/USD'],
    description: 'Stored pair values folded into this one',
  })
  matchedPairs: string[];

  @ApiProperty({
    type: [PairTradeDto],
    description: 'Trades inside the requested range',
  })
  trades: PairTradeDto[];

  @ApiProperty({
    type: PairPositionDto,
    description:
      'Computed over the FULL history of the pair, not just the visible range',
  })
  position: PairPositionDto;

  @ApiProperty({
    example: 2,
    description: 'Trades outside the requested range',
  })
  outsideRange: number;

  @ApiProperty({
    type: [CrossTradeDto],
    description:
      'Trades of the base asset on OTHER pairs (NEXO/BTC when asking for ' +
      'BTC/USDT), inside the requested range. They do not move `position`; ' +
      'they explain why the P&L module holds a different amount and cost ' +
      'for the asset',
  })
  crossTrades: CrossTradeDto[];

  @ApiProperty({
    example: 26,
    description: 'Cross trades across the whole history',
  })
  crossTradeCount: number;
}
