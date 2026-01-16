import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PriceBaselineDocument = PriceBaseline & Document;

@Schema({ timestamps: true, collection: 'price_baselines' })
export class PriceBaseline {
  @Prop({ required: true, index: true })
  symbol: string;

  @Prop({ required: true })
  price: number;

  @Prop({ required: true })
  timestamp: Date;
}

export const PriceBaselineSchema = SchemaFactory.createForClass(PriceBaseline);

PriceBaselineSchema.index({ symbol: 1 }, { unique: true });
