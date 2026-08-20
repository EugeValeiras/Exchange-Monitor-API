import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import {
  PaperOrderSide,
  PaperOrderStatus,
  PaperOrderType,
} from '../dto/paper-order.enums';

export type PaperOrderDocument = PaperOrder & Document;

@Schema({ timestamps: true, collection: 'paper_orders' })
export class PaperOrder {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'PaperAccount', required: true })
  accountId: Types.ObjectId;

  @Prop({ required: true })
  symbol: string; // "BTC/USDT"

  @Prop({ required: true, enum: PaperOrderSide })
  side: PaperOrderSide;

  @Prop({ required: true, enum: PaperOrderType })
  type: PaperOrderType;

  @Prop({ required: true, enum: PaperOrderStatus })
  status: PaperOrderStatus;

  @Prop({ required: true, type: Number })
  amount: number;

  @Prop({ type: Number })
  quoteAmount?: number;

  @Prop({ type: Number })
  limitPrice?: number;

  @Prop({ type: Number })
  stopPrice?: number;

  @Prop({ required: true, type: Number })
  requestedPrice: number;

  @Prop({ type: Number })
  filledPrice?: number;

  @Prop()
  filledAt?: Date;

  @Prop({ type: Number })
  fee?: number;

  @Prop()
  feeAsset?: string;

  @Prop()
  note?: string;

  @Prop()
  rejectReason?: string;

  // Funds locked while the order is open (released on fill/cancel/reject)
  @Prop({ type: Number })
  lockedAmount?: number;

  @Prop()
  lockedAsset?: string;

  // Realized PnL of this fill (sells only) — used for win-rate stats
  @Prop({ type: Number })
  realizedPnl?: number;

  // Bilateral OCO link: when one leg fills or is canceled, the other is auto-canceled.
  // The leg created WITH ocoPartnerId set at creation time is the secondary and holds no lock.
  @Prop({ type: Types.ObjectId, ref: 'PaperOrder' })
  ocoPartnerId?: Types.ObjectId;
}

export const PaperOrderSchema = SchemaFactory.createForClass(PaperOrder);

PaperOrderSchema.index({ userId: 1, accountId: 1, status: 1 });
PaperOrderSchema.index({ userId: 1, createdAt: -1 });
PaperOrderSchema.index({ status: 1, symbol: 1 });
