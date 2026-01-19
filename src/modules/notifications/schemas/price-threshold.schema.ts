import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PriceThresholdDocument = PriceThreshold & Document;

@Schema({ timestamps: true, collection: 'price_thresholds' })
export class PriceThreshold {
  @Prop({ required: true, index: true })
  asset: string;

  @Prop({ required: true })
  lastThresholdLevel: number;

  @Prop({ required: true })
  lastPrice: number;

  @Prop({ required: true })
  timestamp: Date;
}

export const PriceThresholdSchema =
  SchemaFactory.createForClass(PriceThreshold);

PriceThresholdSchema.index({ asset: 1 }, { unique: true });
