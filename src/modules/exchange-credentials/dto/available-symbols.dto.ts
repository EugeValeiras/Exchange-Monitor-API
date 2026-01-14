import { ApiProperty } from '@nestjs/swagger';

export class AvailableSymbolDto {
  @ApiProperty({ example: 'BTC/USDT' })
  symbol: string;

  @ApiProperty({ example: 'BTC' })
  base: string;

  @ApiProperty({ example: 'USDT' })
  quote: string;
}

export class AvailableSymbolsResponseDto {
  @ApiProperty()
  exchange: string;

  @ApiProperty({ type: [AvailableSymbolDto] })
  symbols: AvailableSymbolDto[];

  @ApiProperty()
  total: number;

  @ApiProperty()
  cachedAt: Date;
}
