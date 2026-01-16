import { Injectable, Logger } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { NotificationSettingsDto } from './dto/notification-settings.dto';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly usersService: UsersService) {}

  async registerToken(userId: string, token: string): Promise<void> {
    await this.usersService.addPushToken(userId, token);
    this.logger.log(`Push token registered for user ${userId}`);
  }

  async removeToken(userId: string, token: string): Promise<void> {
    await this.usersService.removePushToken(userId, token);
    this.logger.log(`Push token removed for user ${userId}`);
  }

  async getSettings(userId: string): Promise<NotificationSettingsDto> {
    const user = await this.usersService.findById(userId);
    return {
      enabled: user.notificationSettings?.enabled ?? false,
      priceChangeThreshold: user.notificationSettings?.priceChangeThreshold ?? 5,
      quietHoursStart: user.notificationSettings?.quietHoursStart,
      quietHoursEnd: user.notificationSettings?.quietHoursEnd,
    };
  }

  async updateSettings(
    userId: string,
    settings: NotificationSettingsDto,
  ): Promise<NotificationSettingsDto> {
    const updated = await this.usersService.updateNotificationSettings(userId, settings);
    this.logger.log(`Notification settings updated for user ${userId}`);
    return {
      enabled: updated.notificationSettings?.enabled ?? false,
      priceChangeThreshold: updated.notificationSettings?.priceChangeThreshold ?? 5,
      quietHoursStart: updated.notificationSettings?.quietHoursStart,
      quietHoursEnd: updated.notificationSettings?.quietHoursEnd,
    };
  }
}
