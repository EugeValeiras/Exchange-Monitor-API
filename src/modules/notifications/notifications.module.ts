import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { FirebaseService } from './firebase.service';
import { PriceAlertService } from './price-alert.service';
import { ThresholdAlertService } from './threshold-alert.service';
import { PriceBaseline, PriceBaselineSchema } from './schemas/price-baseline.schema';
import { PriceThreshold, PriceThresholdSchema } from './schemas/price-threshold.schema';
import { UsersModule } from '../users/users.module';
import { BalancesModule } from '../balances/balances.module';
import { SnapshotsModule } from '../snapshots/snapshots.module';
import { PricesModule } from '../prices/prices.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PriceBaseline.name, schema: PriceBaselineSchema },
      { name: PriceThreshold.name, schema: PriceThresholdSchema },
    ]),
    forwardRef(() => UsersModule),
    BalancesModule,
    SnapshotsModule,
    PricesModule,
  ],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    FirebaseService,
    PriceAlertService,
    ThresholdAlertService,
  ],
  exports: [NotificationsService, FirebaseService],
})
export class NotificationsModule {}
