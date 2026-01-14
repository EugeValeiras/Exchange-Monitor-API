import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { PnlService } from './pnl.service';
import {
  PnlSummaryResponseDto,
  UnrealizedPnlResponseDto,
  RealizedPnlItemDto,
} from './dto/pnl-response.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('pnl')
@Controller('api/pnl')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class PnlController {
  constructor(private readonly pnlService: PnlService) {}

  @Get('summary')
  @ApiOperation({ summary: 'Get P&L summary including realized and unrealized' })
  @ApiResponse({ status: 200, type: PnlSummaryResponseDto })
  async getSummary(
    @CurrentUser('userId') userId: string,
  ): Promise<PnlSummaryResponseDto> {
    return this.pnlService.getSummary(userId);
  }

  @Get('unrealized')
  @ApiOperation({ summary: 'Get unrealized P&L for current holdings' })
  @ApiResponse({ status: 200, type: UnrealizedPnlResponseDto })
  async getUnrealizedPnl(
    @CurrentUser('userId') userId: string,
  ): Promise<UnrealizedPnlResponseDto> {
    return this.pnlService.getUnrealizedPnl(userId);
  }

  @Get('realized')
  @ApiOperation({ summary: 'Get realized P&L history' })
  @ApiQuery({ name: 'startDate', required: false, example: '2024-01-01' })
  @ApiQuery({ name: 'endDate', required: false, example: '2024-12-31' })
  @ApiResponse({ status: 200, type: [RealizedPnlItemDto] })
  async getRealizedPnl(
    @CurrentUser('userId') userId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ): Promise<RealizedPnlItemDto[]> {
    const start = startDate ? new Date(startDate) : undefined;
    const end = endDate ? new Date(endDate) : undefined;
    return this.pnlService.getRealizedPnl(userId, start, end);
  }

  @Post('recalculate')
  @ApiOperation({ summary: 'Recalculate all P&L from transaction history' })
  @ApiResponse({ status: 200 })
  async recalculate(
    @CurrentUser('userId') userId: string,
  ): Promise<{ processed: number; message: string }> {
    const result = await this.pnlService.recalculateAll(userId);
    return {
      processed: result.processed,
      message: `P&L recalculation complete. Processed ${result.processed} transactions.`,
    };
  }
}
