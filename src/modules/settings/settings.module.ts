import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  PricingSettings,
  PricingSettingsSchema,
} from './schemas/pricing-settings.schema';
import { SettingsService } from './settings.service';
import { SettingsController } from './settings.controller';
import { ExchangeCredentialsModule } from '../exchange-credentials/exchange-credentials.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PricingSettings.name, schema: PricingSettingsSchema },
    ]),
    ExchangeCredentialsModule, // For MarketsCacheService
  ],
  controllers: [SettingsController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
