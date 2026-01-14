import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { DailySnapshotJob } from './daily-snapshot.job';
import { HourlySnapshotJob } from './hourly-snapshot.job';
import { SyncTransactionsJob } from './sync-transactions.job';
import { SnapshotsModule } from '../modules/snapshots/snapshots.module';
import { TransactionsModule } from '../modules/transactions/transactions.module';
import { UsersModule } from '../modules/users/users.module';
import { ExchangeCredentialsModule } from '../modules/exchange-credentials/exchange-credentials.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    SnapshotsModule,
    TransactionsModule,
    UsersModule,
    ExchangeCredentialsModule,
  ],
  providers: [DailySnapshotJob, HourlySnapshotJob, SyncTransactionsJob],
})
export class JobsModule {}
