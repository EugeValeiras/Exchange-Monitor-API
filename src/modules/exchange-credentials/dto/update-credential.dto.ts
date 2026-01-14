import { IsString, IsOptional, IsBoolean, IsArray } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateCredentialDto {
  @ApiProperty({ required: false, example: 'Mi cuenta Binance actualizada' })
  @IsOptional()
  @IsString()
  label?: string;

  @ApiProperty({ required: false, example: 'new-api-key' })
  @IsOptional()
  @IsString()
  apiKey?: string;

  @ApiProperty({ required: false, example: 'new-api-secret' })
  @IsOptional()
  @IsString()
  apiSecret?: string;

  @ApiProperty({ required: false, example: 'new-passphrase' })
  @IsOptional()
  @IsString()
  passphrase?: string;

  @ApiProperty({ required: false, example: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiProperty({ required: false, type: [String], example: ['BTC/USDT', 'ETH/USDT'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  symbols?: string[];
}
