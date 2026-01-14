import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsString } from 'class-validator';

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

export class PricingSymbolsResponseDto {
  @ApiProperty({
    type: [String],
    example: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
  })
  symbols: string[];
}
