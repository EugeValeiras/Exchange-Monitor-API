import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type RealizedPnlDocument = RealizedPnl & Document;

@Schema({ _id: false })
export class LotBreakdown {
  @Prop({ type: Types.ObjectId, ref: 'CostBasisLot' })
  lotId: Types.ObjectId;

  @Prop({ required: true, type: Number })
  amount: number;

  @Prop({ required: true, type: Number })
  costPerUnit: number;

  @Prop({ required: true })
  acquiredAt: Date;
}

export const LotBreakdownSchema = SchemaFactory.createForClass(LotBreakdown);

@Schema({ timestamps: true, collection: 'realized_pnl' })
export class RealizedPnl {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Transaction', required: true })
  transactionId: Types.ObjectId;

  @Prop({ required: true })
  asset: string;

  @Prop({ required: true, type: Number })
  amount: number;

  @Prop({ required: true, type: Number })
  proceeds: number; // Sale value in USD

  @Prop({ required: true, type: Number })
  costBasis: number; // Total cost basis in USD

  @Prop({ required: true, type: Number })
  realizedPnl: number; // proceeds - costBasis

  @Prop({ required: true })
  realizedAt: Date;

  @Prop()
  holdingPeriod: string; // 'short_term' | 'long_term'

  @Prop({ type: [LotBreakdownSchema], default: [] })
  lotBreakdown: LotBreakdown[];

  @Prop({ required: true })
  exchange: string;
}

export const RealizedPnlSchema = SchemaFactory.createForClass(RealizedPnl);

// Index for querying by user and date
RealizedPnlSchema.index({ userId: 1, realizedAt: -1 });

// Index for querying by asset
RealizedPnlSchema.index({ userId: 1, asset: 1 });
