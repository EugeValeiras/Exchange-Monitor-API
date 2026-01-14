import { IsArray, IsString, ArrayMinSize } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateSymbolsDto {
  @ApiProperty({ type: [String], example: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'] })
  @IsArray()
  @IsString({ each: true })
  symbols: string[];
}
