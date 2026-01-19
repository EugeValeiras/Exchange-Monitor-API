import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { DailySnapshotJob } from './daily-snapshot.job';
import { HourlySnapshotJob } from './hourly-snapshot.job';
import { SyncTransactionsJob } from './sync-transactions.job';
import { WidgetRefreshJob } from './widget-refresh.job';
import { SnapshotsModule } from '../modules/snapshots/snapshots.module';
import { TransactionsModule } from '../modules/transactions/transactions.module';
import { UsersModule } from '../modules/users/users.module';
import { ExchangeCredentialsModule } from '../modules/exchange-credentials/exchange-credentials.module';
import { NotificationsModule } from '../modules/notifications/notifications.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    SnapshotsModule,
    TransactionsModule,
    UsersModule,
    ExchangeCredentialsModule,
    NotificationsModule,
  ],
  providers: [
    DailySnapshotJob,
    HourlySnapshotJob,
    SyncTransactionsJob,
    WidgetRefreshJob,
  ],
})
export class JobsModule {}
