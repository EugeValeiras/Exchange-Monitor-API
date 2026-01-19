import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { FirebaseService } from '../modules/notifications/firebase.service';
import { NotificationsService } from '../modules/notifications/notifications.service';
import { UsersService } from '../modules/users/users.service';

@Injectable()
export class WidgetRefreshJob {
  private readonly logger = new Logger(WidgetRefreshJob.name);

  constructor(
    private readonly firebaseService: FirebaseService,
    private readonly notificationsService: NotificationsService,
    private readonly usersService: UsersService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleWidgetRefresh(): Promise<void> {
    this.logger.log('Starting widget refresh job...');

    try {
      // Get all users
      const users = await this.usersService.findAll();

      let totalTokens = 0;
      let totalSuccess = 0;

      for (const user of users) {
        const tokens = await this.notificationsService.getUserTokens(user.id);
        if (tokens.length === 0) continue;

        totalTokens += tokens.length;

        const result = await this.firebaseService.sendSilentPushMulticast(
          tokens,
          {
            action: 'refresh_widget',
          },
        );

        totalSuccess += result.successCount;
      }

      this.logger.log(
        `Widget refresh completed: ${totalSuccess}/${totalTokens} tokens notified`,
      );
    } catch (error) {
      this.logger.error('Widget refresh job failed:', error);
    }
  }
}
