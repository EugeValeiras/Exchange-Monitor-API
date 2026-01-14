import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type CostBasisLotDocument = CostBasisLot & Document;

@Schema({ timestamps: true, collection: 'cost_basis_lots' })
export class CostBasisLot {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ required: true })
  asset: string;

  @Prop({ required: true, type: Number })
  originalAmount: number;

  @Prop({ required: true, type: Number })
  remainingAmount: number;

  @Prop({ required: true, type: Number })
  costPerUnit: number; // Price paid per unit in USD

  @Prop({ required: true })
  acquiredAt: Date;

  @Prop({ type: Types.ObjectId, ref: 'Transaction' })
  transactionId: Types.ObjectId;

  @Prop({ required: true })
  exchange: string;

  @Prop({ required: true })
  source: string; // 'buy', 'deposit', 'interest', 'transfer_in'
}

export const CostBasisLotSchema = SchemaFactory.createForClass(CostBasisLot);

// Index for FIFO queries - find oldest lots first
CostBasisLotSchema.index({ userId: 1, asset: 1, acquiredAt: 1 });

// Index for finding lots with remaining amount
CostBasisLotSchema.index({ userId: 1, asset: 1, remainingAmount: 1 });
