import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SnapshotsService } from '../modules/snapshots/snapshots.service';
import { UsersService } from '../modules/users/users.service';

@Injectable()
export class HourlySnapshotJob {
  private readonly logger = new Logger(HourlySnapshotJob.name);

  constructor(
    private readonly snapshotsService: SnapshotsService,
    private readonly usersService: UsersService,
    private readonly configService: ConfigService,
  ) {}

  private isEnabled(): boolean {
    const globalEnabled = this.configService.get<boolean>('crons.enabled', true);
    const jobEnabled = this.configService.get<boolean>('crons.hourlySnapshot', true);
    return globalEnabled && jobEnabled;
  }

  @Cron(CronExpression.EVERY_HOUR, {
    name: 'hourly-snapshot',
    timeZone: 'UTC',
  })
  async handleHourlySnapshot(): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.debug('Hourly snapshot job is disabled');
      return;
    }
    this.logger.log('Starting hourly snapshot job...');

    try {
      const users = await this.usersService.findAllActive();

      let successCount = 0;
      let errorCount = 0;

      for (const user of users) {
        try {
          await this.snapshotsService.generateHourlySnapshot(user._id);
          successCount++;
          this.logger.debug(`Hourly snapshot generated for user ${user._id}`);
        } catch (error) {
          errorCount++;
          this.logger.error(
            `Failed to generate hourly snapshot for user ${user._id}: ${error.message}`,
          );
        }
      }

      this.logger.log(
        `Hourly snapshot completed. Success: ${successCount}, Errors: ${errorCount}`,
      );
    } catch (error) {
      this.logger.error(
        `Hourly snapshot job failed: ${error.message}`,
        error.stack,
      );
    }
  }
}
