import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type PricingSettingsDocument = PricingSettings & Document;

@Schema({ timestamps: true, collection: 'pricing_settings' })
export class PricingSettings {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, unique: true })
  userId: Types.ObjectId;

  // DEPRECATED - kept for backward compatibility
  @Prop({ type: [String], default: [] })
  symbols: string[];

  // NEW - symbols per exchange
  @Prop({ type: Object, default: {} })
  symbolsByExchange: Record<string, string[]>;
}

export const PricingSettingsSchema =
  SchemaFactory.createForClass(PricingSettings);

PricingSettingsSchema.index({ userId: 1 }, { unique: true });
