import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DailySnapshot, DailySnapshotSchema } from './schemas/daily-snapshot.schema';
import { HourlySnapshot, HourlySnapshotSchema } from './schemas/hourly-snapshot.schema';
import { SnapshotsController } from './snapshots.controller';
import { SnapshotsService } from './snapshots.service';
import { BalancesModule } from '../balances/balances.module';
import { PricesModule } from '../prices/prices.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: DailySnapshot.name, schema: DailySnapshotSchema },
      { name: HourlySnapshot.name, schema: HourlySnapshotSchema },
    ]),
    BalancesModule,
    PricesModule,
  ],
  controllers: [SnapshotsController],
  providers: [SnapshotsService],
  exports: [SnapshotsService],
})
export class SnapshotsModule {}
