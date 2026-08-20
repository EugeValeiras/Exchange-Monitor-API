import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type PaperPositionDocument = PaperPosition & Document;

@Schema({ timestamps: true, collection: 'paper_positions' })
export class PaperPosition {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'PaperAccount', required: true })
  accountId: Types.ObjectId;

  @Prop({ required: true })
  asset: string;

  @Prop({ required: true, type: Number, default: 0 })
  amount: number;

  @Prop({ required: true, type: Number, default: 0 })
  avgEntryPrice: number;

  @Prop({ required: true, type: Number, default: 0 })
  realizedPnl: number;

  @Prop({ required: true, type: Number, default: 0 })
  feesPaid: number;
}

export const PaperPositionSchema = SchemaFactory.createForClass(PaperPosition);

PaperPositionSchema.index({ accountId: 1, asset: 1 }, { unique: true });
