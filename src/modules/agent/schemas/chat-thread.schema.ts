import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

export type ChatThreadDocument = ChatThread & Document;

@Schema({ _id: false })
export class ChatToolRecord {
  @Prop({ required: true }) id: string;
  @Prop({ required: true }) name: string;
  @Prop({ type: MongooseSchema.Types.Mixed }) input?: unknown;
  @Prop() result?: string;
  @Prop({ default: false }) isError?: boolean;
}

const ChatToolRecordSchema = SchemaFactory.createForClass(ChatToolRecord);

@Schema({ _id: false })
export class ChatMessageEntry {
  @Prop({ required: true }) id: string;
  @Prop({ required: true, enum: ['user', 'assistant'] }) role: 'user' | 'assistant';
  @Prop({ default: '' }) text: string;
  @Prop({ type: [ChatToolRecordSchema], default: [] }) tools: ChatToolRecord[];
  @Prop() error?: string;
  @Prop({ default: () => new Date() }) createdAt: Date;
}

const ChatMessageEntrySchema = SchemaFactory.createForClass(ChatMessageEntry);

@Schema({ collection: 'chat_threads', timestamps: true })
export class ChatThread {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true, index: true })
  userId: Types.ObjectId;

  @Prop({ default: 'Nueva conversación' })
  title: string;

  /** Claude Code session id used with --resume */
  @Prop({ default: null })
  claudeSessionId: string | null;

  @Prop({ default: 'sonnet', enum: ['sonnet', 'opus', 'haiku'] })
  model: 'sonnet' | 'opus' | 'haiku';

  @Prop({ type: [ChatMessageEntrySchema], default: [] })
  messages: ChatMessageEntry[];

  /** Total cost so far (USD) */
  @Prop({ default: 0 })
  costUsd: number;

  /** Aggregated token counters */
  @Prop({ default: 0 }) inputTokens: number;
  @Prop({ default: 0 }) outputTokens: number;
  @Prop({ default: 0 }) cachedTokens: number;
}

export const ChatThreadSchema = SchemaFactory.createForClass(ChatThread);
ChatThreadSchema.index({ userId: 1, updatedAt: -1 });
