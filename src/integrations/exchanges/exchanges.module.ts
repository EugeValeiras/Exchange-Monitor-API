import { Module } from '@nestjs/common';
import { ExchangeFactoryService } from './exchange-factory.service';

@Module({
  providers: [ExchangeFactoryService],
  exports: [ExchangeFactoryService],
})
export class ExchangesModule {}
