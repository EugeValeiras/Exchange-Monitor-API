import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  PaperOrderSide,
  PaperOrderStatus,
  PaperOrderType,
} from './paper-order.enums';

export class PaperBalanceDto {
  @ApiProperty()
  free: number;

  @ApiProperty()
  locked: number;
}

export class PaperAccountResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  initialBalance: number;

  @ApiProperty()
  feeRate: number;

  @ApiProperty()
  slippageBps: number;

  @ApiProperty({ type: Object, description: 'Balances per asset' })
  balances: Record<string, PaperBalanceDto>;

  @ApiProperty({ description: 'Current equity in USDT' })
  equity: number;

  @ApiProperty()
  totalPnl: number;

  @ApiProperty()
  totalPnlPct: number;

  @ApiProperty()
  createdAt: Date;
}

export class PaperOrderResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  accountId: string;

  @ApiProperty()
  symbol: string;

  @ApiProperty({ enum: PaperOrderSide })
  side: PaperOrderSide;

  @ApiProperty({ enum: PaperOrderType })
  type: PaperOrderType;

  @ApiProperty({ enum: PaperOrderStatus })
  status: PaperOrderStatus;

  @ApiProperty()
  amount: number;

  @ApiPropertyOptional()
  quoteAmount?: number;

  @ApiPropertyOptional()
  limitPrice?: number;

  @ApiPropertyOptional()
  stopPrice?: number;

  @ApiProperty()
  requestedPrice: number;

  @ApiPropertyOptional()
  filledPrice?: number;

  @ApiPropertyOptional()
  filledAt?: Date;

  @ApiPropertyOptional()
  fee?: number;

  @ApiPropertyOptional()
  feeAsset?: string;

  @ApiPropertyOptional()
  note?: string;

  @ApiPropertyOptional()
  rejectReason?: string;

  @ApiPropertyOptional({ description: 'Realized PnL of this fill (sells)' })
  realizedPnl?: number;

  @ApiPropertyOptional({
    description:
      'Id of the OCO partner leg (when one leg fills or is canceled, the other is auto-canceled)',
  })
  ocoPartnerId?: string;

  @ApiProperty()
  createdAt: Date;
}

export class PaginatedPaperOrdersDto {
  @ApiProperty({ type: [PaperOrderResponseDto] })
  data: PaperOrderResponseDto[];

  @ApiProperty()
  total: number;

  @ApiProperty()
  page: number;

  @ApiProperty()
  limit: number;

  @ApiProperty()
  totalPages: number;
}

export class PaperPositionResponseDto {
  @ApiProperty()
  asset: string;

  @ApiProperty()
  amount: number;

  @ApiProperty()
  avgEntryPrice: number;

  @ApiProperty()
  currentPrice: number;

  @ApiProperty()
  valueUsd: number;

  @ApiProperty()
  unrealizedPnl: number;

  @ApiProperty()
  unrealizedPnlPct: number;

  @ApiProperty()
  realizedPnl: number;
}

export class EquityCurvePointDto {
  @ApiProperty()
  timestamp: Date;

  @ApiProperty()
  equity: number;
}

export class PaperPerformanceResponseDto {
  @ApiProperty()
  initialBalance: number;

  @ApiProperty()
  equity: number;

  @ApiProperty()
  totalPnl: number;

  @ApiProperty()
  totalPnlPct: number;

  @ApiProperty()
  realizedPnl: number;

  @ApiProperty()
  unrealizedPnl: number;

  @ApiProperty()
  feesPaid: number;

  @ApiProperty({ description: 'Number of filled orders' })
  totalTrades: number;

  @ApiPropertyOptional({
    description: 'Winning sells / total sells (null if no sells)',
    nullable: true,
  })
  winRate: number | null;

  @ApiProperty({ description: 'Max drawdown % over equity snapshots' })
  maxDrawdownPct: number;

  @ApiProperty()
  openOrders: number;

  @ApiProperty({ type: [EquityCurvePointDto] })
  equityCurve: EquityCurvePointDto[];
}
