import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export enum AgentModel {
  SONNET = 'sonnet',
  OPUS = 'opus',
  HAIKU = 'haiku',
  FABLE = 'fable',
}

export const AGENT_MODELS: AgentModel[] = Object.values(AgentModel);

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

  @ApiPropertyOptional({
    description:
      'Plan mode: the agent researches read-only and presents a plan before acting (no state mutations this turn).',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  planMode?: boolean;
}
