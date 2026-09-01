import {
  IsArray,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  Max,
} from 'class-validator';

export class NotificationSettingsDto {
  @IsBoolean()
  enabled: boolean;

  @IsNumber()
  @Min(1)
  @Max(50)
  priceChangeThreshold: number;

  @IsOptional()
  @IsString()
  quietHoursStart?: string;

  @IsOptional()
  @IsString()
  quietHoursEnd?: string;

  /// Activos que generan aviso. Omitirlo deja la selección como estaba; un
  /// array vacío es "no me avises de nada".
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  alertAssets?: string[];
}

export class NotificationSettingsResponseDto {
  enabled: boolean;
  priceChangeThreshold: number;
  quietHoursStart?: string;
  quietHoursEnd?: string;
  alertAssets?: string[];
}
