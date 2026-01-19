import {
  Controller,
  Get,
  Put,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
  ApiParam,
} from '@nestjs/swagger';
import { SettingsService } from './settings.service';
import { MarketsCacheService } from '../exchange-credentials/markets-cache.service';
import {
  UpdateExchangeSymbolsDto,
  ExchangeSymbolsResponseDto,
  AllSymbolsResponseDto,
} from './dto/update-symbols.dto';
import { AvailableSymbolsResponseDto } from '../exchange-credentials/dto/available-symbols.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ExchangeType } from '../../common/constants/exchanges.constant';

@ApiTags('settings')
@Controller('settings')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class SettingsController {
  constructor(
    private readonly settingsService: SettingsService,
    private readonly marketsCacheService: MarketsCacheService,
  ) {}

  // Get all symbols grouped by exchange
  @Get('symbols')
  @ApiOperation({ summary: 'Get all configured symbols grouped by exchange' })
  @ApiResponse({ status: 200, type: AllSymbolsResponseDto })
  async getAllSymbols(
    @CurrentUser('userId') userId: string,
  ): Promise<AllSymbolsResponseDto> {
    const symbolsByExchange = await this.settingsService.getAllSymbolsByExchange(userId);
    return { symbolsByExchange };
  }

  // Get available symbols for an exchange (must be before :exchange param route)
  @Get('symbols/available/:exchange')
  @ApiOperation({ summary: 'Get available symbols for an exchange' })
  @ApiResponse({ status: 200, type: AvailableSymbolsResponseDto })
  @ApiQuery({ name: 'search', required: false, example: 'BTC' })
  async getAvailableSymbols(
    @Param('exchange') exchange: ExchangeType,
    @Query('search') search?: string,
  ): Promise<AvailableSymbolsResponseDto> {
    const result = await this.marketsCacheService.getAvailableSymbols(
      exchange,
      search,
    );
    return {
      exchange,
      symbols: result.symbols,
      total: result.symbols.length,
      cachedAt: result.cachedAt,
    };
  }

  // Get symbols for a specific exchange
  @Get('symbols/:exchange')
  @ApiOperation({ summary: 'Get configured symbols for a specific exchange' })
  @ApiResponse({ status: 200, type: ExchangeSymbolsResponseDto })
  @ApiParam({ name: 'exchange', example: 'binance' })
  async getExchangeSymbols(
    @CurrentUser('userId') userId: string,
    @Param('exchange') exchange: string,
  ): Promise<ExchangeSymbolsResponseDto> {
    const symbols = await this.settingsService.getSymbolsForExchange(userId, exchange);
    return { exchange, symbols };
  }

  // Update symbols for a specific exchange
  @Put('symbols/:exchange')
  @ApiOperation({ summary: 'Update symbols for a specific exchange' })
  @ApiResponse({ status: 200, type: ExchangeSymbolsResponseDto })
  @ApiParam({ name: 'exchange', example: 'binance' })
  async updateExchangeSymbols(
    @CurrentUser('userId') userId: string,
    @Param('exchange') exchange: string,
    @Body() dto: UpdateExchangeSymbolsDto,
  ): Promise<ExchangeSymbolsResponseDto> {
    const symbols = await this.settingsService.updateSymbolsForExchange(
      userId,
      exchange,
      dto.symbols,
    );
    return { exchange, symbols };
  }
}
