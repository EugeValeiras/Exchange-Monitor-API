import { ApiProperty } from '@nestjs/swagger';

export class SwapExchangeResultDto {
  @ApiProperty({ example: 'binance' })
  exchange: string;

  @ApiProperty({ example: 'Binance' })
  exchangeLabel: string;

  @ApiProperty({ description: 'Effective rate: how much TO per 1 FROM', example: 84000 })
  rate: number;

  @ApiProperty({ example: 0.001 })
  takerFeeRate: number;

  @ApiProperty({ example: 0.001 })
  makerFeeRate: number;

  @ApiProperty({ description: 'Fee amount in TO currency', example: 84 })
  feeAmount: number;

  @ApiProperty({ description: 'Amount before fees', example: 84000 })
  grossAmount: number;

  @ApiProperty({ description: 'Amount after fees', example: 83916 })
  netAmount: number;

  @ApiProperty({ description: 'Trading pair used', example: 'BTC/USDT' })
  pair: string;

  @ApiProperty({
    description: 'Route if going through intermediate currency',
    nullable: true,
    example: ['BTC/USDT', 'ETH/USDT'],
  })
  route: string[] | null;

  @ApiProperty({ example: true })
  isBest: boolean;
}

export class SwapPreviewResponseDto {
  @ApiProperty({ example: 'BTC' })
  from: string;

  @ApiProperty({ example: 'USDT' })
  to: string;

  @ApiProperty({ example: 1 })
  amount: number;

  @ApiProperty({ type: [SwapExchangeResultDto] })
  results: SwapExchangeResultDto[];
}
