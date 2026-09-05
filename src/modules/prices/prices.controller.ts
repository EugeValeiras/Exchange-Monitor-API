import { Controller, Get, Post, Body, Param, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { PricesService } from './prices.service';
import { PriceResponseDto, ConvertResponseDto } from './dto/price-response.dto';
import { SwapPreviewResponseDto } from './dto/swap-preview.dto';
import { ExecuteSwapDto, SwapExecutionResultDto } from './dto/swap-execute.dto';
import {
  RawOrderbookResponseDto,
  RawTickerResponseDto,
  OpenOrdersResponseDto,
} from './dto/raw-price.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ExchangeType } from '../../common/constants/exchanges.constant';

@ApiTags('prices')
@Controller('prices')
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

  @Get('swap-preview')
  @ApiOperation({ summary: 'Preview swap across exchanges with fees' })
  @ApiQuery({ name: 'from', example: 'BTC' })
  @ApiQuery({ name: 'to', example: 'USDT' })
  @ApiQuery({ name: 'amount', example: 1 })
  @ApiResponse({ status: 200, type: SwapPreviewResponseDto })
  async getSwapPreview(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('amount') amount: number,
    @CurrentUser('userId') userId: string,
  ): Promise<SwapPreviewResponseDto> {
    return this.pricesService.getSwapPreview(
      from.toUpperCase(),
      to.toUpperCase(),
      Number(amount),
      userId,
    );
  }

  @Post('swap-execute')
  @ApiOperation({ summary: 'Execute a swap on a specific exchange' })
  @ApiResponse({ status: 201, type: SwapExecutionResultDto })
  async executeSwap(
    @Body() dto: ExecuteSwapDto,
    @CurrentUser('userId') userId: string,
  ): Promise<SwapExecutionResultDto> {
    return this.pricesService.executeSwap(
      dto.from.toUpperCase(),
      dto.to.toUpperCase(),
      dto.amount,
      dto.exchange,
      userId,
    );
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

  @Get('raw/:exchange/open-orders')
  @ApiOperation({
    summary: 'Órdenes puestas y todavía sin ejecutar, leídas del exchange',
  })
  @ApiParam({ name: 'exchange', example: 'binance' })
  @ApiQuery({
    name: 'symbol',
    required: false,
    example: 'BTC/USDT',
    description: 'Sin esto se piden todas, que en Binance pesa mucho más',
  })
  @ApiResponse({ status: 200, type: OpenOrdersResponseDto })
  async getOpenOrders(
    @Param('exchange') exchange: ExchangeType,
    @Query('symbol') symbol: string | undefined,
    @CurrentUser('userId') userId: string,
  ): Promise<OpenOrdersResponseDto> {
    return this.pricesService.fetchOpenOrders(exchange, { symbol, userId });
  }

  @Get('raw/:exchange/orderbook')
  @ApiOperation({
    summary: 'Raw order book from an exchange via CCXT (bypasses cache)',
    description:
      'Returns the raw order book for a symbol from Binance/Kraken/Coinbase. Public by default. ' +
      'Set `asMe=true` to use the authenticated user\'s API credentials for that exchange.',
  })
  @ApiQuery({ name: 'symbol', example: 'BTC/USDT' })
  @ApiQuery({ name: 'depth', required: false, example: 20, description: '1–100 (default 20)' })
  @ApiQuery({ name: 'asMe', required: false, example: 'false' })
  @ApiResponse({ status: 200, type: RawOrderbookResponseDto })
  @ApiResponse({ status: 400, description: 'Exchange not supported or CCXT fetch failed' })
  @ApiResponse({ status: 404, description: 'asMe=true and no credential for this exchange' })
  async getRawOrderbook(
    @Param('exchange') exchange: string,
    @Query('symbol') symbol: string,
    @Query('depth') depth: string | undefined,
    @Query('asMe') asMe: string | undefined,
    @CurrentUser('userId') userId: string,
  ): Promise<RawOrderbookResponseDto> {
    return this.pricesService.getRawOrderbook(exchange as ExchangeType, symbol, {
      userId,
      asMe: asMe === 'true',
      depth: depth ? parseInt(depth, 10) : undefined,
    });
  }

  @Get('raw/:exchange')
  @ApiOperation({
    summary: 'Raw ticker from an exchange via CCXT (bypasses cache)',
    description:
      'Returns the raw ticker for a symbol from Binance/Kraken/Coinbase. Public by default. ' +
      'Set `asMe=true` to use the authenticated user\'s API credentials (reflects their fee tier, rate limits, etc.).',
  })
  @ApiQuery({ name: 'symbol', example: 'BTC/USDT' })
  @ApiQuery({ name: 'asMe', required: false, example: 'false' })
  @ApiResponse({ status: 200, type: RawTickerResponseDto })
  @ApiResponse({ status: 400, description: 'Exchange not supported or CCXT fetch failed' })
  @ApiResponse({ status: 404, description: 'asMe=true and no credential for this exchange' })
  async getRawTicker(
    @Param('exchange') exchange: string,
    @Query('symbol') symbol: string,
    @Query('asMe') asMe: string | undefined,
    @CurrentUser('userId') userId: string,
  ): Promise<RawTickerResponseDto> {
    return this.pricesService.getRawTicker(exchange as ExchangeType, symbol, {
      userId,
      asMe: asMe === 'true',
    });
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
