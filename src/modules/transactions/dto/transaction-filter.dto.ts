import { IsOptional, IsString, IsEnum, IsDateString, IsNumber, IsBoolean, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { TransactionType } from '../../../common/constants/transaction-types.constant';
import { ExchangeType } from '../../../common/constants/exchanges.constant';

export class TransactionFilterDto {
  /**
   * Junta en una sola fila las ejecuciones de una misma orden.
   *
   * Un exchange parte una orden grande contra varios niveles del libro y
   * devuelve cada ejecución como un trade aparte: 142 filas para 44 órdenes,
   * y una sola llegó a ocupar 52 renglones seguidos. Agrupar es una decisión
   * de PRESENTACIÓN — el P&L y los lotes se siguen calculando con las
   * ejecuciones — y por eso viene apagado: quien pide la lista cruda la
   * sigue recibiendo igual.
   */
  @ApiProperty({ required: false, default: false })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  groupFills?: boolean = false;

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

  @ApiProperty({
    required: false,
    example: 'BTC/USDT',
    description:
      'Trading pair. USD-family quotes are interchangeable: BTC/USDT also matches BTC/USD',
  })
  @IsOptional()
  @IsString()
  pair?: string;

  @ApiProperty({ required: false, example: '2024-01-01' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiProperty({ required: false, example: '2024-12-31' })
  @IsOptional()
  @IsDateString()
  endDate?: string;
}
