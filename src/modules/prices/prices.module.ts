import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { PricesController } from './prices.controller';
import { PriceHistoryController } from './price-history.controller';
import { PricesService } from './prices.service';
import { PriceHistoryService } from './price-history.service';
import { PriceHistoryInitializerService } from './price-history-initializer.service';
import { PricesGateway } from './websocket/prices.gateway';
import { PriceAggregatorService } from './websocket/price-aggregator.service';
import { BinanceStreamService } from './websocket/binance-stream.service';
import { BinanceFuturesStreamService } from './websocket/binance-futures-stream.service';
import { KrakenStreamService } from './websocket/kraken-stream.service';
import { NexoStreamService } from './websocket/nexo-stream.service';
import { ExchangeCredentialsModule } from '../exchange-credentials/exchange-credentials.module';
import { SettingsModule } from '../settings/settings.module';
import { ExchangesModule } from '../../integrations/exchanges/exchanges.module';
import {
  PriceHistory,
  PriceHistorySchema,
} from './schemas/price-history.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PriceHistory.name, schema: PriceHistorySchema },
    ]),
    EventEmitterModule.forRoot(),
    ExchangeCredentialsModule,
    forwardRef(() => SettingsModule),
    ExchangesModule,
  ],
  controllers: [PricesController, PriceHistoryController],
  providers: [
    PricesService,
    PriceHistoryService,
    PriceHistoryInitializerService,
    PricesGateway,
    PriceAggregatorService,
    BinanceStreamService,
    BinanceFuturesStreamService,
    KrakenStreamService,
  ],
  exports: [
    PricesService,
    PriceAggregatorService,
    PriceHistoryService,
    PriceHistoryInitializerService,
  ],
})
export class PricesModule {}
