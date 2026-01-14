import { ApiProperty } from '@nestjs/swagger';

export class AssetPnlDto {
  @ApiProperty()
  asset: string;

  @ApiProperty()
  realizedPnl: number;

  @ApiProperty()
  unrealizedPnl: number;

  @ApiProperty()
  totalCostBasis: number;

  @ApiProperty()
  currentValue: number;

  @ApiProperty()
  totalAmount: number;
}

export class PeriodBreakdownDto {
  @ApiProperty()
  today: number;

  @ApiProperty()
  thisWeek: number;

  @ApiProperty()
  thisMonth: number;

  @ApiProperty()
  thisYear: number;

  @ApiProperty()
  allTime: number;
}

export class PnlSummaryResponseDto {
  @ApiProperty()
  totalRealizedPnl: number;

  @ApiProperty()
  totalUnrealizedPnl: number;

  @ApiProperty()
  totalPnl: number;

  @ApiProperty({ type: [AssetPnlDto] })
  byAsset: AssetPnlDto[];

  @ApiProperty({ type: PeriodBreakdownDto })
  periodBreakdown: PeriodBreakdownDto;
}

export class UnrealizedPnlDto {
  @ApiProperty()
  asset: string;

  @ApiProperty()
  amount: number;

  @ApiProperty()
  costBasis: number;

  @ApiProperty()
  currentValue: number;

  @ApiProperty()
  unrealizedPnl: number;

  @ApiProperty()
  unrealizedPnlPercent: number;
}

export class UnrealizedPnlResponseDto {
  @ApiProperty()
  totalUnrealizedPnl: number;

  @ApiProperty({ type: [UnrealizedPnlDto] })
  positions: UnrealizedPnlDto[];
}

export class RealizedPnlItemDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  asset: string;

  @ApiProperty()
  amount: number;

  @ApiProperty()
  proceeds: number;

  @ApiProperty()
  costBasis: number;

  @ApiProperty()
  realizedPnl: number;

  @ApiProperty()
  realizedAt: Date;

  @ApiProperty()
  exchange: string;
}
