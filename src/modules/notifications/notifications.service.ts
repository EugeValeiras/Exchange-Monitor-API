import { Injectable, Logger } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { FirebaseService } from './firebase.service';
import { NotificationSettingsDto } from './dto/notification-settings.dto';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly firebaseService: FirebaseService,
  ) {}

  /**
   * Send a notification with fully configurable content to all of a user's
   * registered devices. Used for ad-hoc/bot-driven alerts.
   */
  async sendToUser(
    userId: string,
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<{ success: boolean; successCount: number; totalTokens: number }> {
    const tokens = await this.getUserTokens(userId);
    if (tokens.length === 0) {
      return { success: false, successCount: 0, totalTokens: 0 };
    }

    const result = await this.firebaseService.sendMulticastNotification(
      tokens,
      title,
      body,
      { type: 'custom', ...data },
    );

    this.logger.log(
      `Custom notification for user ${userId}: ${result.successCount}/${tokens.length} delivered`,
    );

    return {
      success: result.successCount > 0,
      successCount: result.successCount,
      totalTokens: tokens.length,
    };
  }

  async registerToken(userId: string, token: string): Promise<void> {
    await this.usersService.addPushToken(userId, token);
    this.logger.log(`Push token registered for user ${userId}`);
  }

  async removeToken(userId: string, token: string): Promise<void> {
    await this.usersService.removePushToken(userId, token);
    this.logger.log(`Push token removed for user ${userId}`);
  }

  async getUserTokens(userId: string): Promise<string[]> {
    const user = await this.usersService.findById(userId);
    return user?.pushTokens ?? [];
  }

  async getAllUserTokens(): Promise<string[]> {
    const users = await this.usersService.findUsersWithPushTokens();
    const allTokens: string[] = [];
    users.forEach((user) => {
      if (user.pushTokens && user.pushTokens.length > 0) {
        allTokens.push(...user.pushTokens);
      }
    });
    return allTokens;
  }

  /**
   * Tokens of users who have price-change notifications enabled in their
   * per-user settings. Used to honor each user's opt-out for broadcast
   * price alerts.
   */
  async getEnabledUserTokens(): Promise<string[]> {
    const users = await this.usersService.findUsersWithNotificationsEnabled();
    const allTokens: string[] = [];
    users.forEach((user) => {
      if (user.pushTokens && user.pushTokens.length > 0) {
        allTokens.push(...user.pushTokens);
      }
    });
    return allTokens;
  }

  /**
   * Tokens de los usuarios a los que este movimiento SÍ les corresponde: los
   * que tienen las alertas activadas, cuyo umbral supera el movimiento, y que
   * no están en su franja de silencio.
   *
   * Antes las alertas de precio salían a todo el que tuviera notificaciones
   * activadas, sin mirar ni el umbral ni el horario: la pantalla ofrecía los
   * dos controles y el backend los ignoraba.
   */
  async getTokensForPriceChange(absPercentChange: number): Promise<string[]> {
    const users = await this.usersService.findUsersWithNotificationsEnabled();
    const tokens: string[] = [];

    for (const user of users) {
      const settings = user.notificationSettings;
      if (!settings?.enabled) continue;
      if (!user.pushTokens?.length) continue;

      const threshold = settings.priceChangeThreshold ?? 5;
      if (absPercentChange < threshold) continue;

      if (!NotificationsService.isOutsideQuietHours(settings)) continue;

      tokens.push(...user.pushTokens);
    }

    return tokens;
  }

  /**
   * ¿Estamos fuera de la franja de silencio del usuario? Sin franja definida,
   * siempre. Contempla que cruce la medianoche (23:00 → 08:00).
   */
  static isOutsideQuietHours(settings: {
    quietHoursStart?: string;
    quietHoursEnd?: string;
  }): boolean {
    if (!settings.quietHoursStart || !settings.quietHoursEnd) return true;

    const now = new Date();
    const currentTime = now.getHours() * 60 + now.getMinutes();

    const [startHour, startMinute] = settings.quietHoursStart.split(':').map(Number);
    const [endHour, endMinute] = settings.quietHoursEnd.split(':').map(Number);
    const startTime = startHour * 60 + startMinute;
    const endTime = endHour * 60 + endMinute;

    if (startTime > endTime) {
      // La franja cruza la medianoche (23:00 → 08:00).
      return currentTime >= endTime && currentTime < startTime;
    }
    return currentTime < startTime || currentTime >= endTime;
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
