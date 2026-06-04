import { Module } from '@nestjs/common';
import { MarketAnalysisService } from './market-analysis.service';
import { MarketAnalysisController } from './market-analysis.controller';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [SettingsModule],
  controllers: [MarketAnalysisController],
  providers: [MarketAnalysisService],
})
export class MarketAnalysisModule {}
