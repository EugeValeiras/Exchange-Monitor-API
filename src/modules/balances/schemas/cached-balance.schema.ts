import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export interface CachedAssetBalance {
  asset: string;
  free: number;
  locked: number;
  total: number;
  priceUsd?: number;
  valueUsd?: number;
  exchanges?: string[];
  exchangeBreakdown?: { exchange: string; total: number }[];
}

export interface CachedExchangeBalance {
  exchange: string;
  label: string;
  credentialId: string;
  balances: CachedAssetBalance[];
  totalValueUsd: number;
}

export interface CachedBalanceData {
  byAsset: CachedAssetBalance[];
  byExchange: CachedExchangeBalance[];
  totalValueUsd: number;
}

export type CachedBalanceDocument = CachedBalance & Document;

@Schema({ timestamps: true, collection: 'cached_balances' })
export class CachedBalance {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, unique: true })
  userId: Types.ObjectId;

  @Prop({ type: Object, required: true })
  data: CachedBalanceData;

  @Prop({ required: true })
  lastSyncAt: Date;

  @Prop({ default: false })
  isSyncing: boolean;
}

export const CachedBalanceSchema = SchemaFactory.createForClass(CachedBalance);

CachedBalanceSchema.index({ userId: 1 }, { unique: true });
