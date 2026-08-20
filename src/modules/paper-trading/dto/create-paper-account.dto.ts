import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreatePaperAccountDto {
  @ApiPropertyOptional({ default: 'default', example: 'rsi-strategy' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string = 'default';

  @ApiPropertyOptional({
    default: 10000,
    minimum: 100,
    description: 'Initial balance in USDT',
  })
  @IsOptional()
  @IsNumber()
  @Min(100)
  initialBalance?: number = 10000;

  @ApiPropertyOptional({
    default: 0.001,
    description: 'Fee rate per trade (0.001 = 0.1%)',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(0.1)
  feeRate?: number = 0.001;

  @ApiPropertyOptional({
    default: 5,
    description: 'Simulated slippage in basis points for taker fills',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1000)
  slippageBps?: number = 5;
}
