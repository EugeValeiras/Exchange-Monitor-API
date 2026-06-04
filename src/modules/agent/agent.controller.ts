import {
  Body,
  Controller,
  Headers,
  Logger,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Request, Response } from 'express';
import { AgentService, AgentEvent } from './agent.service';
import { ChatDto } from './dto/chat.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ChatThreadsService } from './chat-threads.service';
import { ChatMessageEntry, ChatToolRecord } from './schemas/chat-thread.schema';

@ApiTags('agent')
@Controller('agent')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class AgentController {
  private readonly logger = new Logger(AgentController.name);

  constructor(
    private readonly agentService: AgentService,
    private readonly threads: ChatThreadsService,
  ) {}

  @Post('chat/sync')
  @ApiOperation({
    summary: 'Non-streaming chat — buffers events and returns full result. iOS Safari fallback.',
  })
  async chatSync(
    @Body() dto: ChatDto,
    @Headers('authorization') authHeader: string,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
  ): Promise<{ events: any[]; threadId: string }> {
    const jwt = (authHeader ?? '').replace(/^Bearer\s+/i, '').trim();
    if (!jwt) throw new UnauthorizedException('Missing bearer token');

    const { threadId, claudeSessionId } = await this.resolveThread(userId, dto);
    await this.appendUserMessage(userId, threadId, dto.message);

    const controller = new AbortController();
    req.on('close', () => controller.abort());

    const events: any[] = [];
    const collector = new TurnCollector();

    try {
      for await (const event of this.agentService.run({
        message: dto.message,
        sessionId: claudeSessionId ?? undefined,
        model: dto.model,
        jwt,
        signal: controller.signal,
      })) {
        events.push(event);
        collector.handle(event);
      }
    } catch (err) {
      const error = (err as Error).message ?? String(err);
      events.push({ type: 'error', message: error });
      collector.setError(error);
    }

    await this.persistAssistantTurn(userId, threadId, collector);
    return { events: [...events, { type: 'thread', threadId }], threadId };
  }

  @Post('chat')
  @ApiOperation({
    summary: 'Stream a chat turn from the Claude Code subprocess agent',
  })
  async chat(
    @Body() dto: ChatDto,
    @Headers('authorization') authHeader: string,
    @CurrentUser('userId') userId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const jwt = (authHeader ?? '').replace(/^Bearer\s+/i, '').trim();
    if (!jwt) {
      throw new UnauthorizedException('Missing bearer token');
    }

    const { threadId, claudeSessionId } = await this.resolveThread(userId, dto);
    await this.appendUserMessage(userId, threadId, dto.message);

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Content-Encoding', 'identity');
    res.flushHeaders?.();

    // iOS Safari workaround: needs ~2KB of data before it starts flushing
    // chunked SSE responses to JS. Send a leading comment as padding.
    res.write(`: ${'-'.repeat(2048)}\n\n`);

    // Emit the threadId immediately so the frontend can save it even if the
    // user aborts mid-stream.
    res.write(`data: ${JSON.stringify({ type: 'thread', threadId })}\n\n`);

    const controller = new AbortController();
    const onClose = () => {
      this.logger.log('Client closed SSE connection');
      controller.abort();
    };
    req.on('close', onClose);

    const heartbeat = setInterval(() => {
      try {
        res.write(`: heartbeat\n\n`);
      } catch {
        /* noop */
      }
    }, 15_000);

    const collector = new TurnCollector();

    try {
      for await (const event of this.agentService.run({
        message: dto.message,
        sessionId: claudeSessionId ?? undefined,
        model: dto.model,
        jwt,
        signal: controller.signal,
      })) {
        if (controller.signal.aborted) break;
        collector.handle(event);
        res.write(`data: ${JSON.stringify(event)}\n\n`);
        (res as any).flush?.();
      }
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      this.logger.error(`Agent run failed: ${message}`);
      collector.setError(message);
      try {
        res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
      } catch {
        /* noop */
      }
    } finally {
      clearInterval(heartbeat);
      req.off('close', onClose);
      // Persist whatever we collected (even partial responses on abort)
      this.persistAssistantTurn(userId, threadId, collector).catch((err) =>
        this.logger.warn(`Failed to persist turn: ${(err as Error).message}`),
      );
      try {
        res.end();
      } catch {
        /* noop */
      }
    }
  }

  private async resolveThread(
    userId: string,
    dto: ChatDto,
  ): Promise<{ threadId: string; claudeSessionId: string | null }> {
    if (dto.threadId) {
      const existing = await this.threads.get(userId, dto.threadId);
      return {
        threadId: (existing._id as { toString(): string }).toString(),
        claudeSessionId: existing.claudeSessionId,
      };
    }
    const created = await this.threads.create({
      userId,
      model: dto.model,
    });
    return {
      threadId: (created._id as { toString(): string }).toString(),
      claudeSessionId: null,
    };
  }

  private async appendUserMessage(
    userId: string,
    threadId: string,
    text: string,
  ): Promise<void> {
    const entry: ChatMessageEntry = {
      id: this.randomId(),
      role: 'user',
      text,
      tools: [],
      createdAt: new Date(),
    };
    await this.threads.appendMessage({ userId, threadId, message: entry });
  }

  private async persistAssistantTurn(
    userId: string,
    threadId: string,
    collector: TurnCollector,
  ): Promise<void> {
    const entry: ChatMessageEntry = {
      id: this.randomId(),
      role: 'assistant',
      text: collector.text,
      tools: collector.tools,
      error: collector.error,
      createdAt: new Date(),
    };
    await this.threads.appendMessage({ userId, threadId, message: entry });
    await this.threads.updateUsage({
      threadId,
      userId,
      claudeSessionId: collector.claudeSessionId ?? null,
      inputTokens: collector.inputTokens,
      outputTokens: collector.outputTokens,
      cachedTokens: collector.cachedTokens,
      costUsd: collector.costUsd,
    });
  }

  private randomId(): string {
    return (
      Date.now().toString(36) +
      '-' +
      Math.random().toString(36).slice(2, 10)
    );
  }
}

/**
 * Accumulates an assistant turn from the agent event stream into a single
 * persistable record.
 */
class TurnCollector {
  text = '';
  tools: ChatToolRecord[] = [];
  error?: string;
  claudeSessionId: string | null = null;
  inputTokens = 0;
  outputTokens = 0;
  cachedTokens = 0;
  costUsd = 0;

  handle(event: AgentEvent): void {
    switch (event.type) {
      case 'session':
        this.claudeSessionId = event.sessionId;
        break;
      case 'text':
        this.text += event.text;
        break;
      case 'tool_use':
        this.tools.push({
          id: event.id,
          name: event.name,
          input: event.input,
        });
        break;
      case 'tool_result': {
        const tool = this.tools.find((t) => t.id === event.toolUseId);
        if (tool) {
          tool.result = event.content;
          tool.isError = event.isError;
        }
        break;
      }
      case 'usage':
        this.inputTokens = event.inputTokens ?? this.inputTokens;
        this.outputTokens = event.outputTokens ?? this.outputTokens;
        this.cachedTokens = event.cachedTokens ?? this.cachedTokens;
        this.costUsd = event.costUsd ?? this.costUsd;
        break;
      case 'done':
        if (event.sessionId) this.claudeSessionId = event.sessionId;
        break;
      case 'error':
        this.error = event.message;
        break;
    }
  }

  setError(msg: string): void {
    this.error = msg;
  }
}
