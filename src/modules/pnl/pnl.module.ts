import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PnlController } from './pnl.controller';
import { PnlService } from './pnl.service';
import {
  CostBasisLot,
  CostBasisLotSchema,
} from './schemas/cost-basis-lot.schema';
import { RealizedPnl, RealizedPnlSchema } from './schemas/realized-pnl.schema';
import {
  CachedBalance,
  CachedBalanceSchema,
} from '../balances/schemas/cached-balance.schema';
import { PricesModule } from '../prices/prices.module';
import { TransactionsModule } from '../transactions/transactions.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: CostBasisLot.name, schema: CostBasisLotSchema },
      { name: RealizedPnl.name, schema: RealizedPnlSchema },
      // Sólo para leer los saldos reales al reconciliar: el servicio de
      // balances está del otro lado de un ciclo de módulos.
      { name: CachedBalance.name, schema: CachedBalanceSchema },
    ]),
    PricesModule,
    forwardRef(() => TransactionsModule),
  ],
  controllers: [PnlController],
  providers: [PnlService],
  exports: [PnlService],
})
export class PnlModule {}
