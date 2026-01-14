import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  ExchangeCredential,
  ExchangeCredentialSchema,
} from './schemas/exchange-credential.schema';
import { ExchangeCredentialsService } from './exchange-credentials.service';
import { ExchangeCredentialsController } from './exchange-credentials.controller';
import { MarketsCacheService } from './markets-cache.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ExchangeCredential.name, schema: ExchangeCredentialSchema },
    ]),
  ],
  controllers: [ExchangeCredentialsController],
  providers: [ExchangeCredentialsService, MarketsCacheService],
  exports: [ExchangeCredentialsService, MarketsCacheService],
})
export class ExchangeCredentialsModule {}
