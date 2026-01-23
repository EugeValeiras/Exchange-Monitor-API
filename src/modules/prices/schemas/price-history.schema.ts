import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type PriceHistoryDocument = PriceHistory & Document;

@Schema({ timestamps: true, collection: 'price_history' })
export class PriceHistory {
  @Prop({ required: true })
  symbol: string; // "BTC/USDT"

  @Prop({ required: true })
  exchange: string; // "binance", "kraken"

  @Prop({ required: true, type: Number })
  price: number;

  @Prop({ type: Number })
  change24h?: number;

  @Prop({ required: true })
  timestamp: Date;
}

export const PriceHistorySchema = SchemaFactory.createForClass(PriceHistory);

// Index for queries by symbol
PriceHistorySchema.index({ symbol: 1, timestamp: -1 });

// Unique constraint to prevent duplicates
PriceHistorySchema.index(
  { symbol: 1, exchange: 1, timestamp: 1 },
  { unique: true },
);

// TTL index: 30 days retention (2592000 seconds)
PriceHistorySchema.index({ timestamp: 1 }, { expireAfterSeconds: 2592000 });
