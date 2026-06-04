import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { MarketAnalysisService } from './market-analysis.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  IndicatorsQueryDto,
  IndicatorsResponseDto,
  OhlcQueryDto,
  OhlcResponseDto,
  SummaryQueryDto,
  SummaryResponseDto,
} from './dto/market-analysis.dto';

@ApiTags('market-analysis')
@Controller('market-analysis')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class MarketAnalysisController {
  constructor(private readonly marketAnalysisService: MarketAnalysisService) {}

  @Get('ohlc')
  @ApiOperation({ summary: 'Fetch OHLCV candles for a pair' })
  @ApiResponse({ status: 200, type: OhlcResponseDto })
  async getOhlc(@Query() query: OhlcQueryDto): Promise<OhlcResponseDto> {
    return this.marketAnalysisService.getOHLCV(
      query.exchange,
      query.symbol,
      query.timeframe,
      query.limit,
    );
  }

  @Get('indicators')
  @ApiOperation({ summary: 'Fetch OHLCV + technical indicators for a pair' })
  @ApiResponse({ status: 200, type: IndicatorsResponseDto })
  async getIndicators(
    @Query() query: IndicatorsQueryDto,
  ): Promise<IndicatorsResponseDto> {
    return this.marketAnalysisService.getIndicators(
      query.exchange,
      query.symbol,
      query.timeframe,
    );
  }

  @Get('summary')
  @ApiOperation({
    summary: 'Multi-timeframe summary for all configured pairs of an exchange',
  })
  @ApiResponse({ status: 200, type: SummaryResponseDto })
  async getSummary(
    @CurrentUser('userId') userId: string,
    @Query() query: SummaryQueryDto,
  ): Promise<SummaryResponseDto> {
    return this.marketAnalysisService.getMarketSummary(userId, query.exchange);
  }
}
