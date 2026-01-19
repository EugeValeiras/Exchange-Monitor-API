import {
  Controller,
  Post,
  Delete,
  Get,
  Put,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { NotificationsService } from './notifications.service';
import { FirebaseService } from './firebase.service';
import { RegisterTokenDto } from './dto/register-token.dto';
import {
  NotificationSettingsDto,
  NotificationSettingsResponseDto,
} from './dto/notification-settings.dto';

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly firebaseService: FirebaseService,
  ) {}

  @Post('token')
  @HttpCode(HttpStatus.OK)
  async registerToken(
    @CurrentUser('userId') userId: string,
    @Body() dto: RegisterTokenDto,
  ): Promise<{ message: string }> {
    await this.notificationsService.registerToken(userId, dto.token);
    return { message: 'Token registered successfully' };
  }

  @Delete('token/:token')
  @HttpCode(HttpStatus.OK)
  async removeToken(
    @CurrentUser('userId') userId: string,
    @Param('token') token: string,
  ): Promise<{ message: string }> {
    await this.notificationsService.removeToken(userId, token);
    return { message: 'Token removed successfully' };
  }

  @Get('settings')
  async getSettings(
    @CurrentUser('userId') userId: string,
  ): Promise<NotificationSettingsResponseDto> {
    return this.notificationsService.getSettings(userId);
  }

  @Put('settings')
  async updateSettings(
    @CurrentUser('userId') userId: string,
    @Body() dto: NotificationSettingsDto,
  ): Promise<NotificationSettingsResponseDto> {
    return this.notificationsService.updateSettings(userId, dto);
  }

  // DEBUG: Test endpoint to send a notification
  @Post('test')
  @HttpCode(HttpStatus.OK)
  async testNotification(
    @CurrentUser('userId') userId: string,
  ): Promise<{ success: boolean; message: string }> {
    const tokens = await this.notificationsService.getUserTokens(userId);
    if (tokens.length === 0) {
      return { success: false, message: 'No push tokens registered' };
    }

    const token = tokens[0];
    const success = await this.firebaseService.sendNotification(
      token,
      'Test Notification',
      'This is a test notification from Exchange Monitor',
      { type: 'test' },
    );

    return {
      success,
      message: success
        ? 'Notification sent successfully'
        : 'Failed to send notification',
    };
  }

  // Endpoint to send silent push for widget refresh
  @Post('refresh-widget')
  @HttpCode(HttpStatus.OK)
  async refreshWidget(
    @CurrentUser('userId') userId: string,
  ): Promise<{ success: boolean; successCount: number; totalTokens: number }> {
    const tokens = await this.notificationsService.getUserTokens(userId);
    if (tokens.length === 0) {
      return { success: false, successCount: 0, totalTokens: 0 };
    }

    const result = await this.firebaseService.sendSilentPushMulticast(tokens, {
      action: 'refresh_widget',
    });

    return {
      success: result.successCount > 0,
      successCount: result.successCount,
      totalTokens: tokens.length,
    };
  }
}
