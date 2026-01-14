import { ApiProperty } from '@nestjs/swagger';
import { ExchangeType } from '../../../common/constants/exchanges.constant';

export class CredentialResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: ExchangeType })
  exchange: ExchangeType;

  @ApiProperty()
  label: string;

  @ApiProperty()
  isActive: boolean;

  @ApiProperty({ required: false })
  lastSyncAt?: Date;

  @ApiProperty({ required: false })
  lastError?: string;

  @ApiProperty({ type: [String] })
  symbols: string[];

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
