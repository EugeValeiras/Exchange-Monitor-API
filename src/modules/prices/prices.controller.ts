import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { PricesService } from './prices.service';
import { PriceResponseDto, ConvertResponseDto } from './dto/price-response.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('prices')
@Controller('api/prices')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class PricesController {
  constructor(private readonly pricesService: PricesService) {}

  @Get()
  @ApiOperation({ summary: 'Get prices for all user assets' })
  @ApiResponse({ status: 200, type: [PriceResponseDto] })
  async getPricesForUserAssets(
    @CurrentUser('userId') userId: string,
  ): Promise<PriceResponseDto[]> {
    return this.pricesService.getPricesForUserAssets(userId);
  }

  @Get('convert')
  @ApiOperation({ summary: 'Convert amount between assets' })
  @ApiQuery({ name: 'from', example: 'BTC' })
  @ApiQuery({ name: 'to', example: 'USD' })
  @ApiQuery({ name: 'amount', example: 1 })
  @ApiResponse({ status: 200, type: ConvertResponseDto })
  async convert(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('amount') amount: number,
    @CurrentUser('userId') userId: string,
  ): Promise<ConvertResponseDto> {
    return this.pricesService.convert(from, to, Number(amount), userId);
  }

  @Get(':symbol')
  @ApiOperation({ summary: 'Get price for a specific symbol' })
  @ApiResponse({ status: 200, type: PriceResponseDto })
  async getPrice(
    @Param('symbol') symbol: string,
    @CurrentUser('userId') userId: string,
  ): Promise<PriceResponseDto> {
    return this.pricesService.getPrice(symbol, userId);
  }
}
