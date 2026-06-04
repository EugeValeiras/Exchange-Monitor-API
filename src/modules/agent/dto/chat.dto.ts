import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export enum AgentModel {
  SONNET = 'sonnet',
  OPUS = 'opus',
  HAIKU = 'haiku',
}

export class ChatDto {
  @ApiProperty({ example: '¿Cómo viene mi portfolio?', description: 'User message' })
  @IsString()
  @MaxLength(8000)
  message: string;

  @ApiPropertyOptional({
    description: 'Claude Code session ID to resume an existing thread (deprecated — use threadId)',
  })
  @IsOptional()
  @IsString()
  sessionId?: string;

  @ApiPropertyOptional({
    description: 'Persisted chat thread id; if omitted, a new thread is created',
  })
  @IsOptional()
  @IsString()
  threadId?: string;

  @ApiPropertyOptional({ enum: AgentModel, default: AgentModel.SONNET })
  @IsOptional()
  @IsEnum(AgentModel)
  model?: AgentModel;
}
