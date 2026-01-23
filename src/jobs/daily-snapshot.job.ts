import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SnapshotsService } from '../modules/snapshots/snapshots.service';
import { UsersService } from '../modules/users/users.service';

@Injectable()
export class DailySnapshotJob {
  private readonly logger = new Logger(DailySnapshotJob.name);

  constructor(
    private readonly snapshotsService: SnapshotsService,
    private readonly usersService: UsersService,
    private readonly configService: ConfigService,
  ) {}

  private isEnabled(): boolean {
    const globalEnabled = this.configService.get<boolean>('crons.enabled', true);
    const jobEnabled = this.configService.get<boolean>('crons.dailySnapshot', true);
    return globalEnabled && jobEnabled;
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT, {
    name: 'daily-snapshot',
    timeZone: 'UTC',
  })
  async handleDailySnapshot(): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.debug('Daily snapshot job is disabled');
      return;
    }
    this.logger.log('Starting daily snapshot job...');

    try {
      const users = await this.usersService.findAllActive();

      let successCount = 0;
      let errorCount = 0;

      for (const user of users) {
        try {
          await this.snapshotsService.generateSnapshot(user._id);
          successCount++;
          this.logger.debug(`Snapshot generated for user ${user._id}`);
        } catch (error) {
          errorCount++;
          this.logger.error(
            `Failed to generate snapshot for user ${user._id}: ${error.message}`,
          );
        }
      }

      this.logger.log(
        `Daily snapshot completed. Success: ${successCount}, Errors: ${errorCount}`,
      );
    } catch (error) {
      this.logger.error(`Daily snapshot job failed: ${error.message}`, error.stack);
    }
  }

  @Cron('0 */4 * * *', {
    name: 'retry-failed-snapshots',
    timeZone: 'UTC',
  })
  async retryFailedSnapshots(): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.debug('Retry failed snapshots job is disabled');
      return;
    }
    this.logger.log('Checking for missing daily snapshots...');

    try {
      const today = new Date().toISOString().split('T')[0];
      const usersWithoutSnapshot =
        await this.snapshotsService.findUsersWithoutSnapshotForDate(today);

      for (const userId of usersWithoutSnapshot) {
        try {
          await this.snapshotsService.generateSnapshot(userId);
          this.logger.log(`Retry snapshot generated for user ${userId}`);
        } catch (error) {
          this.logger.warn(`Retry failed for user ${userId}: ${error.message}`);
        }
      }
    } catch (error) {
      this.logger.error(`Retry job failed: ${error.message}`);
    }
  }
}
