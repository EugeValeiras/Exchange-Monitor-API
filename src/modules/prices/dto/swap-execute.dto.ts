import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNumber, Min } from 'class-validator';

export class ExecuteSwapDto {
  @ApiProperty({ example: 'BTC' })
  @IsString()
  from: string;

  @ApiProperty({ example: 'USDT' })
  @IsString()
  to: string;

  @ApiProperty({ example: 1 })
  @IsNumber()
  @Min(0)
  amount: number;

  @ApiProperty({ example: 'binance' })
  @IsString()
  exchange: string;
}

export class SwapExecutionResultDto {
  @ApiProperty({ example: 'binance' })
  exchange: string;

  @ApiProperty({ example: '12345678' })
  orderId: string;

  @ApiProperty({ example: 'BTC/USDT' })
  pair: string;

  @ApiProperty({ example: 'sell' })
  side: string;

  @ApiProperty({ example: 'closed' })
  status: string;

  @ApiProperty({ example: 1 })
  amount: number;

  @ApiProperty({ example: 1 })
  filled: number;

  @ApiProperty({ example: 84000 })
  price: number;

  @ApiProperty({ example: 84000 })
  cost: number;

  @ApiProperty({ example: 84, nullable: true })
  fee: number | null;

  @ApiProperty({ example: 'USDT', nullable: true })
  feeAsset: string | null;
}
