import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { ExchangeType } from '../../../common/constants/exchanges.constant';

export type ExchangeCredentialDocument = ExchangeCredential & Document;

@Schema({ timestamps: true, collection: 'exchange_credentials' })
export class ExchangeCredential {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ required: true, enum: ExchangeType })
  exchange: ExchangeType;

  @Prop({ required: true })
  label: string;

  @Prop({ required: true })
  apiKeyEncrypted: string;

  @Prop({ required: true })
  apiSecretEncrypted: string;

  @Prop()
  passphraseEncrypted?: string;

  @Prop({ default: true })
  isActive: boolean;

  @Prop()
  lastSyncAt?: Date;

  @Prop()
  lastError?: string;

  @Prop({ type: [String], default: [] })
  symbols: string[];
}

export const ExchangeCredentialSchema =
  SchemaFactory.createForClass(ExchangeCredential);

ExchangeCredentialSchema.index({ userId: 1 });
ExchangeCredentialSchema.index({ userId: 1, exchange: 1 });
ExchangeCredentialSchema.index({ userId: 1, isActive: 1 });
