import { Controller, Get, Post, Param, Query, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { TransactionsService } from './transactions.service';
import { ExchangeCredentialsService } from '../exchange-credentials/exchange-credentials.service';
import { TransactionFilterDto } from './dto/transaction-filter.dto';
import {
  PaginatedTransactionsDto,
  TransactionStatsDto,
  TransactionResponseDto,
} from './dto/transaction-response.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('transactions')
@Controller('api/transactions')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class TransactionsController {
  constructor(
    private readonly transactionsService: TransactionsService,
    private readonly credentialsService: ExchangeCredentialsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Get transactions with filters and pagination' })
  @ApiResponse({ status: 200, type: PaginatedTransactionsDto })
  async findAll(
    @CurrentUser('userId') userId: string,
    @Query() filter: TransactionFilterDto,
  ): Promise<PaginatedTransactionsDto> {
    return this.transactionsService.findAll(userId, filter);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get transaction statistics' })
  @ApiResponse({ status: 200, type: TransactionStatsDto })
  async getStats(
    @CurrentUser('userId') userId: string,
    @Query('exchange') exchange?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('types') types?: string,
    @Query('assets') assets?: string,
  ): Promise<TransactionStatsDto> {
    return this.transactionsService.getStats(userId, {
      exchange,
      startDate,
      endDate,
      types,
      assets,
    });
  }

  @Post('sync')
  @ApiOperation({ summary: 'Sync transactions from all exchanges' })
  @ApiResponse({ status: 200 })
  async syncAll(
    @CurrentUser('userId') userId: string,
  ): Promise<{ synced: number; message: string }> {
    const synced = await this.transactionsService.syncAllForUser(userId);
    return {
      synced,
      message: `Synced ${synced} transactions from exchanges`,
    };
  }

  @Post('sync/:credentialId')
  @ApiOperation({ summary: 'Sync transactions for a specific credential' })
  @ApiResponse({ status: 200, description: 'Sync completed' })
  @ApiResponse({ status: 404, description: 'Credential not found' })
  async syncCredential(
    @Param('credentialId') credentialId: string,
    @CurrentUser('userId') userId: string,
    @Query('fullSync') fullSync?: string,
  ): Promise<{ synced: number; message: string }> {
    // Verify credential belongs to user (throws 404 if not found)
    await this.credentialsService.findById(credentialId, userId);

    const forceFullSync = fullSync === 'true';
    const synced = await this.transactionsService.syncFromExchange(
      credentialId,
      forceFullSync,
    );
    return {
      synced,
      message: forceFullSync
        ? `Sincronización completa: ${synced} transacciones`
        : `Sincronizadas ${synced} transacciones`,
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get transaction by ID' })
  @ApiResponse({ status: 200, type: TransactionResponseDto })
  @ApiResponse({ status: 404, description: 'Transaction not found' })
  async findOne(
    @Param('id') id: string,
    @CurrentUser('userId') userId: string,
  ): Promise<TransactionResponseDto | null> {
    const tx = await this.transactionsService.findById(id, userId);
    if (!tx) {
      return null;
    }
    return {
      id: tx._id.toString(),
      exchange: tx.exchange,
      externalId: tx.externalId,
      type: tx.type,
      asset: tx.asset,
      amount: tx.amount,
      fee: tx.fee,
      feeAsset: tx.feeAsset,
      price: tx.price,
      priceAsset: tx.priceAsset,
      pair: tx.pair,
      side: tx.side,
      timestamp: tx.timestamp,
    };
  }
}
