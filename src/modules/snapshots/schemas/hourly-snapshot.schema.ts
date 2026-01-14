import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type HourlySnapshotDocument = HourlySnapshot & Document;

@Schema({ _id: false })
export class TopAsset {
  @Prop({ required: true })
  asset: string;

  @Prop({ required: true, type: Number })
  valueUsd: number;
}

export const TopAssetSchema = SchemaFactory.createForClass(TopAsset);

@Schema({ _id: false })
export class SnapshotAssetBalance {
  @Prop({ required: true })
  asset: string;

  @Prop({ required: true, type: Number })
  amount: number;

  @Prop({ type: Number })
  priceUsd?: number;

  @Prop({ required: true, type: Number })
  valueUsd: number;
}

export const SnapshotAssetBalanceSchema =
  SchemaFactory.createForClass(SnapshotAssetBalance);

@Schema({ timestamps: true, collection: 'hourly_snapshots' })
export class HourlySnapshot {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ required: true })
  timestamp: Date;

  @Prop({ required: true, type: Number })
  totalValueUsd: number;

  @Prop({ type: [TopAssetSchema], default: [] })
  topAssets: TopAsset[];

  @Prop({ type: [SnapshotAssetBalanceSchema], default: [] })
  assetBalances: SnapshotAssetBalance[];
}

export const HourlySnapshotSchema = SchemaFactory.createForClass(HourlySnapshot);

// Index for efficient queries by user and time
HourlySnapshotSchema.index({ userId: 1, timestamp: -1 });

// TTL index: auto-delete documents after 7 days (604800 seconds)
HourlySnapshotSchema.index({ timestamp: 1 }, { expireAfterSeconds: 604800 });
