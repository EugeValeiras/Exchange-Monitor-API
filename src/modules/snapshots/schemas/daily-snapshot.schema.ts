import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type DailySnapshotDocument = DailySnapshot & Document;

@Schema({ _id: false })
export class AssetBalance {
  @Prop({ required: true })
  asset: string;

  @Prop({ required: true, type: Number })
  amount: number;

  @Prop({ type: Number })
  priceUsd?: number;

  @Prop({ type: Number })
  valueUsd?: number;
}

export const AssetBalanceSchema = SchemaFactory.createForClass(AssetBalance);

@Schema({ _id: false })
export class ExchangeBalance {
  @Prop({ required: true })
  exchange: string;

  @Prop({ type: Types.ObjectId, ref: 'ExchangeCredential' })
  credentialId: Types.ObjectId;

  @Prop()
  label: string;

  @Prop({ type: [AssetBalanceSchema], default: [] })
  balances: AssetBalance[];

  @Prop({ type: Number })
  totalValueUsd: number;
}

export const ExchangeBalanceSchema = SchemaFactory.createForClass(ExchangeBalance);

@Schema({ timestamps: true, collection: 'daily_snapshots' })
export class DailySnapshot {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ required: true })
  date: string; // Format: YYYY-MM-DD

  @Prop({ required: true })
  snapshotAt: Date;

  @Prop({ type: [ExchangeBalanceSchema], default: [] })
  exchangeBalances: ExchangeBalance[];

  @Prop({ type: [AssetBalanceSchema], default: [] })
  consolidatedBalances: AssetBalance[];

  @Prop({ type: Number })
  totalValueUsd: number;

  @Prop({ type: Object })
  pricesAtSnapshot: Record<string, number>;
}

export const DailySnapshotSchema = SchemaFactory.createForClass(DailySnapshot);

DailySnapshotSchema.index({ userId: 1, date: -1 });
DailySnapshotSchema.index({ userId: 1, date: 1 }, { unique: true });
