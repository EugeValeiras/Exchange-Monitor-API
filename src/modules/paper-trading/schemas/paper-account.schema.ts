import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export interface PaperBalance {
  free: number;
  locked: number;
}

export type PaperAccountDocument = PaperAccount & Document;

@Schema({ timestamps: true, collection: 'paper_accounts' })
export class PaperAccount {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ required: true })
  name: string;

  @Prop({ required: true, type: Number })
  initialBalance: number;

  @Prop({ required: true, type: Number })
  feeRate: number;

  @Prop({ required: true, type: Number })
  slippageBps: number;

  @Prop({ type: Object, required: true })
  balances: Record<string, PaperBalance>;

  @Prop({ default: true })
  isActive: boolean;
}

export const PaperAccountSchema = SchemaFactory.createForClass(PaperAccount);

PaperAccountSchema.index({ userId: 1, name: 1 }, { unique: true });
