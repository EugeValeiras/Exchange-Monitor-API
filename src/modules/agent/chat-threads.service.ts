import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  ChatMessageEntry,
  ChatThread,
  ChatThreadDocument,
} from './schemas/chat-thread.schema';

export interface ThreadSummary {
  id: string;
  title: string;
  model: string;
  claudeSessionId: string | null;
  messageCount: number;
  lastMessagePreview: string;
  costUsd: number;
  updatedAt: Date;
  createdAt: Date;
}

export interface CreateThreadInput {
  userId: string;
  title?: string;
  model?: 'sonnet' | 'opus' | 'haiku';
}

export interface AppendMessageInput {
  threadId: string;
  userId: string;
  message: ChatMessageEntry;
}

export interface UpdateUsageInput {
  threadId: string;
  userId: string;
  claudeSessionId?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  costUsd?: number;
}

@Injectable()
export class ChatThreadsService {
  constructor(
    @InjectModel(ChatThread.name)
    private readonly model: Model<ChatThreadDocument>,
  ) {}

  async list(userId: string, limit = 50): Promise<ThreadSummary[]> {
    const docs = await this.model
      .find({ userId: new Types.ObjectId(userId) })
      .sort({ updatedAt: -1 })
      .limit(limit)
      .lean()
      .exec();
    return docs.map((d) =>
      this.toSummary(
        d as unknown as ChatThread & { _id: Types.ObjectId; updatedAt: Date; createdAt: Date },
      ),
    );
  }

  async get(userId: string, threadId: string): Promise<ChatThreadDocument> {
    const doc = await this.model.findOne({
      _id: new Types.ObjectId(threadId),
      userId: new Types.ObjectId(userId),
    });
    if (!doc) throw new NotFoundException('Thread not found');
    return doc;
  }

  async create(input: CreateThreadInput): Promise<ChatThreadDocument> {
    const doc = await this.model.create({
      userId: new Types.ObjectId(input.userId),
      title: input.title ?? 'Nueva conversación',
      model: input.model ?? 'sonnet',
      messages: [],
    });
    return doc;
  }

  async delete(userId: string, threadId: string): Promise<void> {
    const result = await this.model.deleteOne({
      _id: new Types.ObjectId(threadId),
      userId: new Types.ObjectId(userId),
    });
    if (result.deletedCount === 0) throw new NotFoundException('Thread not found');
  }

  async rename(userId: string, threadId: string, title: string): Promise<ChatThreadDocument> {
    const doc = await this.model.findOneAndUpdate(
      {
        _id: new Types.ObjectId(threadId),
        userId: new Types.ObjectId(userId),
      },
      { $set: { title } },
      { new: true },
    );
    if (!doc) throw new NotFoundException('Thread not found');
    return doc;
  }

  async appendMessage(input: AppendMessageInput): Promise<ChatThreadDocument> {
    // Auto-derive title from first user message if still default
    const doc = await this.model.findOne({
      _id: new Types.ObjectId(input.threadId),
      userId: new Types.ObjectId(input.userId),
    });
    if (!doc) throw new NotFoundException('Thread not found');

    doc.messages.push(input.message);

    if (
      input.message.role === 'user' &&
      doc.messages.filter((m) => m.role === 'user').length === 1 &&
      (!doc.title || doc.title === 'Nueva conversación')
    ) {
      doc.title = input.message.text.slice(0, 60).trim() || 'Nueva conversación';
    }

    await doc.save();
    return doc;
  }

  async updateUsage(input: UpdateUsageInput): Promise<void> {
    const update: Record<string, unknown> = {};
    if (input.claudeSessionId !== undefined) {
      update.claudeSessionId = input.claudeSessionId;
    }
    const inc: Record<string, number> = {};
    if (input.inputTokens) inc.inputTokens = input.inputTokens;
    if (input.outputTokens) inc.outputTokens = input.outputTokens;
    if (input.cachedTokens) inc.cachedTokens = input.cachedTokens;
    if (input.costUsd) inc.costUsd = input.costUsd;

    const ops: Record<string, unknown> = {};
    if (Object.keys(update).length) ops.$set = update;
    if (Object.keys(inc).length) ops.$inc = inc;
    if (!Object.keys(ops).length) return;

    await this.model.updateOne(
      {
        _id: new Types.ObjectId(input.threadId),
        userId: new Types.ObjectId(input.userId),
      },
      ops,
    );
  }

  private toSummary(doc: ChatThread & { _id: Types.ObjectId; updatedAt: Date; createdAt: Date }): ThreadSummary {
    const lastMsg = doc.messages?.length ? doc.messages[doc.messages.length - 1] : null;
    return {
      id: doc._id.toString(),
      title: doc.title,
      model: doc.model,
      claudeSessionId: doc.claudeSessionId,
      messageCount: doc.messages?.length ?? 0,
      lastMessagePreview: lastMsg?.text?.slice(0, 120) ?? '',
      costUsd: doc.costUsd ?? 0,
      updatedAt: doc.updatedAt,
      createdAt: doc.createdAt,
    };
  }
}
