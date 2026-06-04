import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ChatThreadsService, ThreadSummary } from './chat-threads.service';

@ApiTags('agent')
@Controller('agent/threads')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class ChatThreadsController {
  constructor(private readonly threads: ChatThreadsService) {}

  @Get()
  async list(@CurrentUser('userId') userId: string): Promise<ThreadSummary[]> {
    return this.threads.list(userId);
  }

  @Get(':id')
  async get(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
  ): Promise<unknown> {
    const doc = await this.threads.get(userId, id);
    const obj = doc.toJSON() as Record<string, unknown> & { _id: { toString(): string } };
    return { ...obj, id: obj._id.toString() };
  }

  @Post()
  async create(
    @CurrentUser('userId') userId: string,
    @Body() body: { title?: string; model?: 'sonnet' | 'opus' | 'haiku' },
  ): Promise<{ id: string }> {
    const doc = await this.threads.create({ userId, ...body });
    return { id: (doc._id as { toString(): string }).toString() };
  }

  @Patch(':id')
  async rename(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
    @Body() body: { title: string },
  ): Promise<{ id: string; title: string }> {
    const doc = await this.threads.rename(userId, id, body.title);
    return { id: (doc._id as { toString(): string }).toString(), title: doc.title };
  }

  @Delete(':id')
  async delete(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    await this.threads.delete(userId, id);
    return { ok: true };
  }
}
