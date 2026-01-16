import { Module, forwardRef } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { PricesController } from './prices.controller';
import { PricesService } from './prices.service';
import { PricesGateway } from './websocket/prices.gateway';
import { PriceAggregatorService } from './websocket/price-aggregator.service';
import { BinanceStreamService } from './websocket/binance-stream.service';
import { KrakenStreamService } from './websocket/kraken-stream.service';
import { NexoStreamService } from './websocket/nexo-stream.service';
import { ExchangeCredentialsModule } from '../exchange-credentials/exchange-credentials.module';
import { SettingsModule } from '../settings/settings.module';
import { ExchangesModule } from '../../integrations/exchanges/exchanges.module';

@Module({
  imports: [
    EventEmitterModule.forRoot(),
    ExchangeCredentialsModule,
    forwardRef(() => SettingsModule),
    ExchangesModule,
  ],
  controllers: [PricesController],
  providers: [
    PricesService,
    PricesGateway,
    PriceAggregatorService,
    BinanceStreamService,
    KrakenStreamService,
  ],
  exports: [PricesService, PriceAggregatorService],
})
export class PricesModule {}
