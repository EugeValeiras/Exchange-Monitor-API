import { IsOptional, IsString, IsEnum, IsDateString, IsNumber, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { TransactionType } from '../../../common/constants/transaction-types.constant';
import { ExchangeType } from '../../../common/constants/exchanges.constant';

export class TransactionFilterDto {
  @ApiProperty({ required: false, default: 1 })
  @IsOptional()
  @Transform(({ value }) => parseInt(value))
  @IsNumber()
  @Min(1)
  page?: number = 1;

  @ApiProperty({ required: false, default: 20 })
  @IsOptional()
  @Transform(({ value }) => parseInt(value))
  @IsNumber()
  @Min(1)
  limit?: number = 20;

  @ApiProperty({ required: false, enum: ExchangeType })
  @IsOptional()
  @IsEnum(ExchangeType)
  exchange?: ExchangeType;

  @ApiProperty({ required: false, enum: TransactionType })
  @IsOptional()
  @IsEnum(TransactionType)
  type?: TransactionType;

  @ApiProperty({ required: false, example: 'deposit,trade', description: 'Comma-separated list of types' })
  @IsOptional()
  @IsString()
  types?: string;

  @ApiProperty({ required: false, example: 'BTC' })
  @IsOptional()
  @IsString()
  asset?: string;

  @ApiProperty({ required: false, example: 'BTC,ETH,USDT', description: 'Comma-separated list of assets' })
  @IsOptional()
  @IsString()
  assets?: string;

  @ApiProperty({ required: false, example: '2024-01-01' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiProperty({ required: false, example: '2024-12-31' })
  @IsOptional()
  @IsDateString()
  endDate?: string;
}
