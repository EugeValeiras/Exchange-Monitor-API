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
} from '@nestjs/swagger';
import { SettingsService } from './settings.service';
import { MarketsCacheService } from '../exchange-credentials/markets-cache.service';
import {
  UpdatePricingSymbolsDto,
  PricingSymbolsResponseDto,
} from './dto/update-symbols.dto';
import { AvailableSymbolsResponseDto } from '../exchange-credentials/dto/available-symbols.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ExchangeType } from '../../common/constants/exchanges.constant';

@ApiTags('settings')
@Controller('api/settings')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class SettingsController {
  constructor(
    private readonly settingsService: SettingsService,
    private readonly marketsCacheService: MarketsCacheService,
  ) {}

  @Get('symbols')
  @ApiOperation({ summary: 'Get configured pricing symbols for current user' })
  @ApiResponse({ status: 200, type: PricingSymbolsResponseDto })
  async getSymbols(
    @CurrentUser('userId') userId: string,
  ): Promise<PricingSymbolsResponseDto> {
    const symbols = await this.settingsService.getSymbols(userId);
    return { symbols };
  }

  @Put('symbols')
  @ApiOperation({ summary: 'Update pricing symbols for current user' })
  @ApiResponse({ status: 200, type: PricingSymbolsResponseDto })
  async updateSymbols(
    @CurrentUser('userId') userId: string,
    @Body() dto: UpdatePricingSymbolsDto,
  ): Promise<PricingSymbolsResponseDto> {
    const symbols = await this.settingsService.updateSymbols(
      userId,
      dto.symbols,
    );
    return { symbols };
  }

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
}
