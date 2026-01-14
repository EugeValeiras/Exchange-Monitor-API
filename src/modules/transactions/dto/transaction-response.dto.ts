import { ApiProperty } from '@nestjs/swagger';
import { TransactionType } from '../../../common/constants/transaction-types.constant';

export class TransactionResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  exchange: string;

  @ApiProperty()
  externalId: string;

  @ApiProperty({ enum: TransactionType })
  type: TransactionType;

  @ApiProperty()
  asset: string;

  @ApiProperty()
  amount: number;

  @ApiProperty({ required: false })
  fee?: number;

  @ApiProperty({ required: false })
  feeAsset?: string;

  @ApiProperty({ required: false })
  price?: number;

  @ApiProperty({ required: false })
  priceAsset?: string;

  @ApiProperty({ required: false })
  pair?: string;

  @ApiProperty({ required: false })
  side?: string;

  @ApiProperty()
  timestamp: Date;
}

export class PaginatedTransactionsDto {
  @ApiProperty({ type: [TransactionResponseDto] })
  data: TransactionResponseDto[];

  @ApiProperty()
  total: number;

  @ApiProperty()
  page: number;

  @ApiProperty()
  limit: number;

  @ApiProperty()
  totalPages: number;
}

export class TransactionStatsDto {
  @ApiProperty()
  totalTransactions: number;

  @ApiProperty()
  byType: Record<string, number>;

  @ApiProperty()
  byExchange: Record<string, number>;

  @ApiProperty()
  byAsset: Record<string, number>;

  @ApiProperty({ example: 1234.56 })
  totalInterestUsd: number;
}
