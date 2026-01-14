import { ApiProperty } from '@nestjs/swagger';

export class PriceResponseDto {
  @ApiProperty({ example: 'BTC/USDT' })
  symbol: string;

  @ApiProperty({ example: 45000 })
  price: number;

  @ApiProperty()
  timestamp: Date;
}

export class ConvertResponseDto {
  @ApiProperty({ example: 'BTC' })
  from: string;

  @ApiProperty({ example: 'USD' })
  to: string;

  @ApiProperty({ example: 1 })
  amount: number;

  @ApiProperty({ example: 45000 })
  result: number;

  @ApiProperty({ example: 45000 })
  rate: number;
}
