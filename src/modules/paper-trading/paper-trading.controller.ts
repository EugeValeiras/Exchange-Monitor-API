import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PaperTradingService } from './paper-trading.service';
import { CreatePaperAccountDto } from './dto/create-paper-account.dto';
import { CreatePaperOrderDto } from './dto/create-paper-order.dto';
import {
  PaperOrderFilterDto,
  PaginationDto,
} from './dto/paper-order-filter.dto';
import {
  PaginatedPaperOrdersDto,
  PaperAccountResponseDto,
  PaperOrderResponseDto,
  PaperPerformanceResponseDto,
  PaperPositionResponseDto,
} from './dto/paper-trading-response.dto';

@ApiTags('paper-trading')
@Controller('paper-trading')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class PaperTradingController {
  constructor(private readonly paperTradingService: PaperTradingService) {}

  // ── Accounts ────────────────────────────────────────────────────

  @Post('accounts')
  @ApiOperation({ summary: 'Create a paper trading account' })
  @ApiResponse({ status: 201, type: PaperAccountResponseDto })
  @ApiResponse({ status: 409, description: 'Account name already exists' })
  async createAccount(
    @CurrentUser('userId') userId: string,
    @Body() dto: CreatePaperAccountDto,
  ): Promise<PaperAccountResponseDto> {
    return this.paperTradingService.createAccount(userId, dto);
  }

  @Get('accounts')
  @ApiOperation({ summary: 'List paper accounts with current equity' })
  @ApiResponse({ status: 200, type: [PaperAccountResponseDto] })
  async listAccounts(
    @CurrentUser('userId') userId: string,
  ): Promise<PaperAccountResponseDto[]> {
    return this.paperTradingService.listAccounts(userId);
  }

  @Get('accounts/:id')
  @ApiOperation({ summary: 'Get paper account detail (balances, equity, PnL)' })
  @ApiResponse({ status: 200, type: PaperAccountResponseDto })
  @ApiResponse({ status: 404, description: 'Account not found' })
  async getAccount(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
  ): Promise<PaperAccountResponseDto> {
    return this.paperTradingService.getAccountDetail(userId, id);
  }

  @Post('accounts/:id/reset')
  @ApiOperation({
    summary:
      'Reset account: cancel open orders, wipe orders/positions/snapshots, restore initial balance',
  })
  @ApiResponse({ status: 200, type: PaperAccountResponseDto })
  @ApiResponse({ status: 404, description: 'Account not found' })
  async resetAccount(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
  ): Promise<PaperAccountResponseDto> {
    return this.paperTradingService.resetAccount(userId, id);
  }

  @Delete('accounts/:id')
  @ApiOperation({ summary: 'Delete account and all associated data' })
  @ApiResponse({ status: 200, description: 'Account deleted' })
  @ApiResponse({ status: 404, description: 'Account not found' })
  async deleteAccount(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
  ): Promise<{ deleted: boolean }> {
    return this.paperTradingService.deleteAccount(userId, id);
  }

  @Get('accounts/:id/positions')
  @ApiOperation({ summary: 'Get open positions with unrealized PnL' })
  @ApiResponse({ status: 200, type: [PaperPositionResponseDto] })
  @ApiResponse({ status: 404, description: 'Account not found' })
  async getPositions(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
  ): Promise<PaperPositionResponseDto[]> {
    return this.paperTradingService.getPositions(userId, id);
  }

  @Get('accounts/:id/performance')
  @ApiOperation({ summary: 'Get account performance metrics + equity curve' })
  @ApiResponse({ status: 200, type: PaperPerformanceResponseDto })
  @ApiResponse({ status: 404, description: 'Account not found' })
  async getPerformance(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
  ): Promise<PaperPerformanceResponseDto> {
    return this.paperTradingService.getPerformance(userId, id);
  }

  @Get('accounts/:id/trades')
  @ApiOperation({ summary: 'Get filled orders (trades) for an account' })
  @ApiResponse({ status: 200, type: PaginatedPaperOrdersDto })
  @ApiResponse({ status: 404, description: 'Account not found' })
  async getTrades(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
    @Query() pagination: PaginationDto,
  ): Promise<PaginatedPaperOrdersDto> {
    return this.paperTradingService.getTrades(userId, id, pagination);
  }

  // ── Orders ──────────────────────────────────────────────────────

  @Post('orders')
  @ApiOperation({
    summary:
      'Create a simulated order (market fills synchronously against real prices)',
  })
  @ApiResponse({ status: 201, type: PaperOrderResponseDto })
  @ApiResponse({
    status: 400,
    description:
      'Invalid order (no price, min notional, insufficient balance, ...)',
  })
  async createOrder(
    @CurrentUser('userId') userId: string,
    @Body() dto: CreatePaperOrderDto,
  ): Promise<PaperOrderResponseDto> {
    return this.paperTradingService.createOrder(userId, dto);
  }

  @Get('orders')
  @ApiOperation({ summary: 'List orders with filters and pagination' })
  @ApiResponse({ status: 200, type: PaginatedPaperOrdersDto })
  async findOrders(
    @CurrentUser('userId') userId: string,
    @Query() filter: PaperOrderFilterDto,
  ): Promise<PaginatedPaperOrdersDto> {
    return this.paperTradingService.findOrders(userId, filter);
  }

  @Get('orders/:id')
  @ApiOperation({ summary: 'Get order by id' })
  @ApiResponse({ status: 200, type: PaperOrderResponseDto })
  @ApiResponse({ status: 404, description: 'Order not found' })
  async findOrder(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
  ): Promise<PaperOrderResponseDto> {
    return this.paperTradingService.findOrderById(userId, id);
  }

  @Delete('orders/:id')
  @ApiOperation({ summary: 'Cancel an open order (releases locked funds)' })
  @ApiResponse({ status: 200, type: PaperOrderResponseDto })
  @ApiResponse({ status: 400, description: 'Order is not open' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  async cancelOrder(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
  ): Promise<PaperOrderResponseDto> {
    return this.paperTradingService.cancelOrder(userId, id);
  }
}
