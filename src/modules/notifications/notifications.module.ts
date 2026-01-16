import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { FirebaseService } from './firebase.service';
import { PriceAlertService } from './price-alert.service';
import { PriceBaseline, PriceBaselineSchema } from './schemas/price-baseline.schema';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PriceBaseline.name, schema: PriceBaselineSchema },
    ]),
    forwardRef(() => UsersModule),
  ],
  controllers: [NotificationsController],
  providers: [NotificationsService, FirebaseService, PriceAlertService],
  exports: [NotificationsService, FirebaseService],
})
export class NotificationsModule {}
