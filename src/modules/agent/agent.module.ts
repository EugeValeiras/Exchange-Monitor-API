import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AgentService } from './agent.service';
import { AgentController } from './agent.controller';
import { ChatThreadsService } from './chat-threads.service';
import { ChatThreadsController } from './chat-threads.controller';
import { ChatThread, ChatThreadSchema } from './schemas/chat-thread.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ChatThread.name, schema: ChatThreadSchema },
    ]),
  ],
  controllers: [AgentController, ChatThreadsController],
  providers: [AgentService, ChatThreadsService],
})
export class AgentModule {}
