import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { PaperOrderSide, PaperOrderType } from './paper-order.enums';

export class CreatePaperOrderDto {
  @ApiProperty({ description: 'Paper account id' })
  @IsMongoId()
  accountId: string;

  @ApiProperty({ example: 'BTC/USDT', description: 'BASE/USDT pair' })
  @IsString()
  @Matches(/^[A-Z0-9]+\/[A-Z0-9]+$/, {
    message: 'symbol must have BASE/QUOTE format (e.g. BTC/USDT)',
  })
  symbol: string;

  @ApiProperty({ enum: PaperOrderSide })
  @IsEnum(PaperOrderSide)
  side: PaperOrderSide;

  @ApiProperty({ enum: PaperOrderType })
  @IsEnum(PaperOrderType)
  type: PaperOrderType;

  @ApiPropertyOptional({
    description: 'Amount in base asset (exactly one of amount/quoteAmount)',
  })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  amount?: number;

  @ApiPropertyOptional({
    description: 'Amount in USDT (exactly one of amount/quoteAmount)',
  })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  quoteAmount?: number;

  @ApiPropertyOptional({ description: 'Required when type=limit' })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  limitPrice?: number;

  @ApiPropertyOptional({
    description: 'Required when type=stop_loss or take_profit',
  })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  stopPrice?: number;

  @ApiPropertyOptional({ description: 'Free-form strategy tag' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;

  @ApiPropertyOptional({
    description:
      'Id of an open SELL order to pair with as an OCO (One-Cancels-Other) ' +
      'bracket. The new order becomes the secondary leg: it shares the ' +
      "partner's base-asset lock (locks no funds itself) and when either " +
      'leg fills or is canceled the other is auto-canceled. Both legs must ' +
      'be SELL orders on the same account/symbol with the same amount.',
  })
  @IsOptional()
  @IsMongoId()
  ocoPartnerId?: string;
}
