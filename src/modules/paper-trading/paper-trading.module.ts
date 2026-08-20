import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PaperTradingController } from './paper-trading.controller';
import { PaperTradingService } from './paper-trading.service';
import { PaperFillEngineService } from './paper-fill-engine.service';
import {
  PaperAccount,
  PaperAccountSchema,
} from './schemas/paper-account.schema';
import { PaperOrder, PaperOrderSchema } from './schemas/paper-order.schema';
import {
  PaperPosition,
  PaperPositionSchema,
} from './schemas/paper-position.schema';
import {
  PaperEquitySnapshot,
  PaperEquitySnapshotSchema,
} from './schemas/paper-equity-snapshot.schema';
import { PricesModule } from '../prices/prices.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PaperAccount.name, schema: PaperAccountSchema },
      { name: PaperOrder.name, schema: PaperOrderSchema },
      { name: PaperPosition.name, schema: PaperPositionSchema },
      { name: PaperEquitySnapshot.name, schema: PaperEquitySnapshotSchema },
    ]),
    PricesModule,
    NotificationsModule,
  ],
  controllers: [PaperTradingController],
  providers: [PaperTradingService, PaperFillEngineService],
  exports: [PaperTradingService],
})
export class PaperTradingModule {}
