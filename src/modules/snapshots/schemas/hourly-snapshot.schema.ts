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

  /**
   * El snapshot se tomó con una lectura incompleta: algún exchange no contestó
   * y su saldo no está sumado. El valor guardado NO es la cartera real de esa
   * hora, así que las series de gráficos lo excluyen.
   */
  @Prop({ type: Boolean, default: false, index: true })
  isPartial?: boolean;

  /** Exchanges que no contestaron cuando se tomó este snapshot. */
  @Prop({ type: [String], default: undefined })
  missingExchanges?: string[];

  /**
   * Activos cuyo precio no llegó y se valuaron con el último precio conocido.
   * El total es bueno; la cotización de estos activos tiene hasta una hora.
   */
  @Prop({ type: [String], default: undefined })
  stalePriceAssets?: string[];

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
