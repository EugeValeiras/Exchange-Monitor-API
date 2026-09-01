import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PriceThresholdDocument = PriceThreshold & Document;

@Schema({ timestamps: true, collection: 'price_thresholds' })
export class PriceThreshold {
  /// El PAR, no el activo: `NEXO/USDT` y `NEXO/BTC` cotizan en escalas
  /// distintas y no pueden compartir el último precio notificado.
  @Prop({ required: true })
  symbol: string;

  /// El activo base, para poder buscar por él sin partir el símbolo.
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

PriceThresholdSchema.index({ symbol: 1 }, { unique: true });
