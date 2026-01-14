import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Transaction, TransactionSchema } from './schemas/transaction.schema';
import { TransactionsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';
import { ExchangeCredentialsModule } from '../exchange-credentials/exchange-credentials.module';
import { ExchangesModule } from '../../integrations/exchanges/exchanges.module';
import { PricesModule } from '../prices/prices.module';
import { PnlModule } from '../pnl/pnl.module';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Transaction.name, schema: TransactionSchema },
    ]),
    ExchangeCredentialsModule,
    ExchangesModule,
    PricesModule,
    forwardRef(() => PnlModule),
    SettingsModule,
  ],
  controllers: [TransactionsController],
  providers: [TransactionsService],
  exports: [TransactionsService],
})
export class TransactionsModule {}
