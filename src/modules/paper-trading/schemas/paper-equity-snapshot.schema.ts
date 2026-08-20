import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type PaperEquitySnapshotDocument = PaperEquitySnapshot & Document;

@Schema({ timestamps: true, collection: 'paper_equity_snapshots' })
export class PaperEquitySnapshot {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  userId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'PaperAccount', required: true })
  accountId: Types.ObjectId;

  @Prop({ required: true })
  timestamp: Date;

  @Prop({ required: true, type: Number })
  equity: number;
}

export const PaperEquitySnapshotSchema =
  SchemaFactory.createForClass(PaperEquitySnapshot);

PaperEquitySnapshotSchema.index({ accountId: 1, timestamp: -1 });

// TTL index: 90 days retention (7776000 seconds)
PaperEquitySnapshotSchema.index(
  { timestamp: 1 },
  { expireAfterSeconds: 7776000 },
);
