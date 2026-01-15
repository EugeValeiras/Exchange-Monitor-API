import { Controller, Get, Post, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
  ApiProduces,
} from '@nestjs/swagger';
import { PnlService } from './pnl.service';
import {
  PnlSummaryResponseDto,
  UnrealizedPnlResponseDto,
  RealizedPnlItemDto,
  PaginatedRealizedPnlDto,
  PaginatedCostBasisLotsDto,
  PnlEvolutionDto,
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

  @Get('realized/paginated')
  @ApiOperation({ summary: 'Get realized P&L with pagination and filters' })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'limit', required: false, example: 20 })
  @ApiQuery({ name: 'startDate', required: false, example: '2024-01-01' })
  @ApiQuery({ name: 'endDate', required: false, example: '2024-12-31' })
  @ApiQuery({ name: 'assets', required: false, description: 'Comma-separated asset filter' })
  @ApiQuery({ name: 'exchanges', required: false, description: 'Comma-separated exchange filter' })
  @ApiResponse({ status: 200, type: PaginatedRealizedPnlDto })
  async getRealizedPnlPaginated(
    @CurrentUser('userId') userId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('assets') assets?: string,
    @Query('exchanges') exchanges?: string,
  ): Promise<PaginatedRealizedPnlDto> {
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 20;
    const start = startDate ? new Date(startDate) : undefined;
    const end = endDate ? new Date(endDate) : undefined;
    const assetsArr = assets ? assets.split(',').map(a => a.trim()) : undefined;
    const exchangesArr = exchanges ? exchanges.split(',').map(e => e.trim()) : undefined;

    return this.pnlService.getRealizedPnlPaginated(
      userId, pageNum, limitNum, start, end, assetsArr, exchangesArr
    );
  }

  @Get('lots')
  @ApiOperation({ summary: 'Get cost basis lots with pagination and filters' })
  @ApiQuery({ name: 'page', required: false, example: 1 })
  @ApiQuery({ name: 'limit', required: false, example: 20 })
  @ApiQuery({ name: 'assets', required: false, description: 'Comma-separated asset filter' })
  @ApiQuery({ name: 'exchanges', required: false, description: 'Comma-separated exchange filter' })
  @ApiQuery({ name: 'showEmpty', required: false, description: 'Include fully consumed lots' })
  @ApiResponse({ status: 200, type: PaginatedCostBasisLotsDto })
  async getCostBasisLots(
    @CurrentUser('userId') userId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('assets') assets?: string,
    @Query('exchanges') exchanges?: string,
    @Query('showEmpty') showEmpty?: string,
  ): Promise<PaginatedCostBasisLotsDto> {
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 20;
    const assetsArr = assets ? assets.split(',').map(a => a.trim()) : undefined;
    const exchangesArr = exchanges ? exchanges.split(',').map(e => e.trim()) : undefined;
    const showEmptyBool = showEmpty === 'true';

    return this.pnlService.getCostBasisLots(
      userId, pageNum, limitNum, assetsArr, exchangesArr, showEmptyBool
    );
  }

  @Get('evolution')
  @ApiOperation({ summary: 'Get P&L evolution data for chart' })
  @ApiQuery({ name: 'timeframe', required: false, example: '1y', description: '1m, 3m, 6m, 1y, all' })
  @ApiResponse({ status: 200, type: PnlEvolutionDto })
  async getPnlEvolution(
    @CurrentUser('userId') userId: string,
    @Query('timeframe') timeframe?: string,
  ): Promise<PnlEvolutionDto> {
    return this.pnlService.getPnlEvolution(userId, timeframe || '1y');
  }

  @Get('filters')
  @ApiOperation({ summary: 'Get available assets and exchanges for filtering' })
  @ApiResponse({ status: 200 })
  async getFilters(
    @CurrentUser('userId') userId: string,
  ): Promise<{ assets: string[]; exchanges: string[] }> {
    const [assets, exchanges] = await Promise.all([
      this.pnlService.getAvailableAssets(userId),
      this.pnlService.getAvailableExchanges(userId),
    ]);
    return { assets, exchanges };
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

  @Get('export')
  @ApiOperation({
    summary: 'Export P&L data to Excel',
    description:
      'Generates an Excel file with cost basis lots, realized P&L, and summary by asset for verification.',
  })
  @ApiProduces('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  @ApiResponse({
    status: 200,
    description: 'Excel file with P&L data',
  })
  async exportToExcel(
    @CurrentUser('userId') userId: string,
    @Res() res: Response,
  ): Promise<void> {
    const buffer = await this.pnlService.exportToExcel(userId);

    const filename = `pnl-export-${new Date().toISOString().split('T')[0]}.xlsx`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }
}
