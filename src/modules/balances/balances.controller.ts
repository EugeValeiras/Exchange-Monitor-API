import { Controller, Get, Post, Param, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { BalancesService } from './balances.service';
import {
  AssetBalanceDto,
  ExchangeBalanceDto,
  ConsolidatedBalanceDto,
} from './dto/balance-response.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('balances')
@Controller('api/balances')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class BalancesController {
  constructor(private readonly balancesService: BalancesService) {}

  @Get()
  @ApiOperation({ summary: 'Get consolidated balances from all exchanges' })
  @ApiResponse({ status: 200, type: ConsolidatedBalanceDto })
  async getConsolidatedBalances(
    @CurrentUser('userId') userId: string,
  ): Promise<ConsolidatedBalanceDto> {
    return this.balancesService.getConsolidatedBalances(userId);
  }

  @Get('by-exchange')
  @ApiOperation({ summary: 'Get balances grouped by exchange' })
  @ApiResponse({ status: 200, type: [ExchangeBalanceDto] })
  async getBalancesByExchange(
    @CurrentUser('userId') userId: string,
  ): Promise<ExchangeBalanceDto[]> {
    return this.balancesService.getBalancesByExchange(userId);
  }

  @Get('by-asset')
  @ApiOperation({ summary: 'Get balances grouped by asset' })
  @ApiResponse({ status: 200, type: [AssetBalanceDto] })
  async getBalancesByAsset(
    @CurrentUser('userId') userId: string,
  ): Promise<AssetBalanceDto[]> {
    return this.balancesService.getBalancesByAsset(userId);
  }

  @Get('credential/:credentialId')
  @ApiOperation({ summary: 'Get balances for a specific credential' })
  @ApiResponse({ status: 200 })
  async getBalancesForCredential(
    @Param('credentialId') credentialId: string,
    @CurrentUser('userId') userId: string,
  ) {
    return this.balancesService.getBalancesForCredential(credentialId, userId);
  }

  @Post('refresh')
  @ApiOperation({ summary: 'Force refresh all balances' })
  @ApiResponse({ status: 200, type: ConsolidatedBalanceDto })
  async refreshBalances(
    @CurrentUser('userId') userId: string,
  ): Promise<ConsolidatedBalanceDto> {
    return this.balancesService.getConsolidatedBalances(userId);
  }
}
