import { ApiProperty } from '@nestjs/swagger';

export class SnapshotAssetDto {
  @ApiProperty()
  asset: string;

  @ApiProperty()
  amount: number;

  @ApiProperty({ required: false })
  priceUsd?: number;

  @ApiProperty({ required: false })
  valueUsd?: number;
}

export class SnapshotExchangeDto {
  @ApiProperty()
  exchange: string;

  @ApiProperty()
  label: string;

  @ApiProperty()
  credentialId: string;

  @ApiProperty({ type: [SnapshotAssetDto] })
  balances: SnapshotAssetDto[];

  @ApiProperty()
  totalValueUsd: number;
}

export class SnapshotResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: '2024-01-15' })
  date: string;

  @ApiProperty()
  snapshotAt: Date;

  @ApiProperty({ type: [SnapshotExchangeDto] })
  exchangeBalances: SnapshotExchangeDto[];

  @ApiProperty({ type: [SnapshotAssetDto] })
  consolidatedBalances: SnapshotAssetDto[];

  @ApiProperty()
  totalValueUsd: number;

  @ApiProperty()
  pricesAtSnapshot: Record<string, number>;
}

export class SnapshotCompareDto {
  @ApiProperty()
  fromDate: string;

  @ApiProperty()
  toDate: string;

  @ApiProperty()
  fromTotalUsd: number;

  @ApiProperty()
  toTotalUsd: number;

  @ApiProperty()
  changeUsd: number;

  @ApiProperty()
  changePercent: number;

  @ApiProperty()
  assetChanges: Array<{
    asset: string;
    fromAmount: number;
    toAmount: number;
    change: number;
  }>;
}

export class ChartDataResponseDto {
  @ApiProperty({ type: [String], description: 'ISO date strings' })
  labels: string[];

  @ApiProperty({ type: [Number], description: 'Total USD values' })
  data: number[];

  @ApiProperty({ description: 'Change in USD from first to last point' })
  changeUsd: number;

  @ApiProperty({ description: 'Percentage change from first to last point' })
  changePercent: number;

  @ApiProperty({ description: 'Timeframe: 24h, 7d, 1m, 1y' })
  timeframe: string;
}

export class AssetChartDataDto {
  @ApiProperty({ description: 'Asset symbol' })
  asset: string;

  @ApiProperty({ type: [Number], description: 'USD values for this asset' })
  data: number[];
}

export class ChartDataByAssetResponseDto {
  @ApiProperty({ type: [String], description: 'ISO date strings' })
  labels: string[];

  @ApiProperty({ type: [Number], description: 'Total USD values' })
  totalData: number[];

  @ApiProperty({ type: [AssetChartDataDto], description: 'Data per asset' })
  assetData: AssetChartDataDto[];

  @ApiProperty({ description: 'Change in USD from first to last point' })
  changeUsd: number;

  @ApiProperty({ description: 'Percentage change from first to last point' })
  changePercent: number;

  @ApiProperty({ description: 'Timeframe: 24h, 7d' })
  timeframe: string;

  @ApiProperty({ type: [String], description: 'All available assets in the data' })
  availableAssets: string[];
}

export class Pnl24hResponseDto {
  @ApiProperty({ description: 'Current total balance value in USD' })
  currentValue: number;

  @ApiProperty({ description: 'Balance value 24 hours ago in USD' })
  value24hAgo: number;

  @ApiProperty({ description: 'Change in USD' })
  changeUsd: number;

  @ApiProperty({ description: 'Percentage change' })
  changePercent: number;
}
