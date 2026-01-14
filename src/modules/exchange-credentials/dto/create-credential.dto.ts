import { IsString, IsEnum, IsOptional, ValidateIf } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { ExchangeType } from '../../../common/constants/exchanges.constant';

export class CreateCredentialDto {
  @ApiProperty({ enum: ExchangeType, example: ExchangeType.BINANCE })
  @IsEnum(ExchangeType)
  exchange: ExchangeType;

  @ApiProperty({ example: 'Mi cuenta Binance principal' })
  @IsString()
  label: string;

  @ApiProperty({
    example: 'your-api-key',
    required: false,
    description: 'Required for all exchanges except nexo-manual',
  })
  @ValidateIf((o) => o.exchange !== ExchangeType.NEXO_MANUAL)
  @IsString()
  apiKey?: string;

  @ApiProperty({
    example: 'your-api-secret',
    required: false,
    description: 'Required for all exchanges except nexo-manual',
  })
  @ValidateIf((o) => o.exchange !== ExchangeType.NEXO_MANUAL)
  @IsString()
  apiSecret?: string;

  @ApiProperty({ required: false, example: 'optional-passphrase' })
  @IsOptional()
  @IsString()
  passphrase?: string;
}
