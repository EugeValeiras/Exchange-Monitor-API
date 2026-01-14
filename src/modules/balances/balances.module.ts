import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BalancesController } from './balances.controller';
import { BalancesService } from './balances.service';
import { BalancesGateway } from './balances.gateway';
import { ExchangeCredentialsModule } from '../exchange-credentials/exchange-credentials.module';
import { ExchangesModule } from '../../integrations/exchanges/exchanges.module';
import { PricesModule } from '../prices/prices.module';
import { TransactionsModule } from '../transactions/transactions.module';
import {
  CachedBalance,
  CachedBalanceSchema,
} from './schemas/cached-balance.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CachedBalance.name, schema: CachedBalanceSchema },
    ]),
    ExchangeCredentialsModule,
    ExchangesModule,
    PricesModule,
    forwardRef(() => TransactionsModule),
  ],
  controllers: [BalancesController],
  providers: [BalancesService, BalancesGateway],
  exports: [BalancesService],
})
export class BalancesModule {}
