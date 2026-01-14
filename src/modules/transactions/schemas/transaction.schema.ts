import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { TransactionType } from '../../../common/constants/transaction-types.constant';

export type TransactionDocument = Transaction & Document;

@Schema({ timestamps: true, collection: 'transactions' })
export class Transaction {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'ExchangeCredential', required: true })
  credentialId: Types.ObjectId;

  @Prop({ required: true })
  exchange: string;

  @Prop({ required: true })
  externalId: string;

  @Prop({ required: true, enum: TransactionType })
  type: TransactionType;

  @Prop({ required: true })
  asset: string;

  @Prop({ required: true, type: Number })
  amount: number;

  @Prop({ type: Number })
  fee?: number;

  @Prop()
  feeAsset?: string;

  @Prop({ type: Number })
  price?: number;

  @Prop()
  priceAsset?: string;

  @Prop({ type: Number })
  total?: number;

  @Prop()
  pair?: string;

  @Prop()
  side?: string;

  @Prop({ required: true })
  timestamp: Date;

  @Prop({ type: Object })
  rawData?: Record<string, unknown>;
}

export const TransactionSchema = SchemaFactory.createForClass(Transaction);

TransactionSchema.index({ userId: 1, timestamp: -1 });
TransactionSchema.index({ userId: 1, exchange: 1, timestamp: -1 });
TransactionSchema.index({ userId: 1, type: 1, timestamp: -1 });
TransactionSchema.index({ userId: 1, asset: 1 });
TransactionSchema.index({ externalId: 1, exchange: 1 }, { unique: true });
