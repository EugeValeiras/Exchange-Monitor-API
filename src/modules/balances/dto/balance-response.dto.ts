import { ApiProperty } from '@nestjs/swagger';

export class AssetBalanceDto {
  @ApiProperty({ example: 'BTC' })
  asset: string;

  @ApiProperty({ example: 0.5 })
  free: number;

  @ApiProperty({ example: 0.1 })
  locked: number;

  @ApiProperty({ example: 0.6 })
  total: number;

  @ApiProperty({ example: 45000, required: false })
  priceUsd?: number;

  @ApiProperty({ example: 27000, required: false })
  valueUsd?: number;

  @ApiProperty({ example: ['binance', 'kraken'], required: false })
  exchanges?: string[];

  @ApiProperty({
    example: [{ exchange: 'binance', total: 0.5 }, { exchange: 'kraken', total: 0.1 }],
    required: false,
  })
  exchangeBreakdown?: { exchange: string; total: number }[];
}

export class ExchangeBalanceDto {
  @ApiProperty({ example: 'binance' })
  exchange: string;

  @ApiProperty({ example: 'Mi cuenta Binance' })
  label: string;

  @ApiProperty({ example: '507f1f77bcf86cd799439011' })
  credentialId: string;

  @ApiProperty({ type: [AssetBalanceDto] })
  balances: AssetBalanceDto[];

  @ApiProperty({ example: 50000 })
  totalValueUsd: number;
}

export class ConsolidatedBalanceDto {
  @ApiProperty({ type: [AssetBalanceDto] })
  byAsset: AssetBalanceDto[];

  @ApiProperty({ type: [ExchangeBalanceDto] })
  byExchange: ExchangeBalanceDto[];

  @ApiProperty({ example: 150000 })
  totalValueUsd: number;

  @ApiProperty()
  lastUpdated: Date;

  @ApiProperty({ example: true, required: false })
  isCached?: boolean;

  @ApiProperty({ example: false, required: false })
  isSyncing?: boolean;

  /**
   * Exchanges cuya consulta de saldos falló en esta lectura. El consolidado se
   * devuelve igual —con lo que sí se pudo traer— pero quien lo persista tiene
   * que saber que está incompleto: un snapshot armado sobre un balance parcial
   * dibuja un desplome que nunca pasó.
   */
  @ApiProperty({ example: [], required: false, type: [String] })
  failedExchanges?: string[];
}
