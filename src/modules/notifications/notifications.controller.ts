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
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { NotificationsService } from './notifications.service';
import { RegisterTokenDto } from './dto/register-token.dto';
import {
  NotificationSettingsDto,
  NotificationSettingsResponseDto,
} from './dto/notification-settings.dto';

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Post('token')
  @HttpCode(HttpStatus.OK)
  async registerToken(
    @CurrentUser('_id') userId: string,
    @Body() dto: RegisterTokenDto,
  ): Promise<{ message: string }> {
    await this.notificationsService.registerToken(userId, dto.token);
    return { message: 'Token registered successfully' };
  }

  @Delete('token/:token')
  @HttpCode(HttpStatus.OK)
  async removeToken(
    @CurrentUser('_id') userId: string,
    @Param('token') token: string,
  ): Promise<{ message: string }> {
    await this.notificationsService.removeToken(userId, token);
    return { message: 'Token removed successfully' };
  }

  @Get('settings')
  async getSettings(
    @CurrentUser('_id') userId: string,
  ): Promise<NotificationSettingsResponseDto> {
    return this.notificationsService.getSettings(userId);
  }

  @Put('settings')
  async updateSettings(
    @CurrentUser('_id') userId: string,
    @Body() dto: NotificationSettingsDto,
  ): Promise<NotificationSettingsResponseDto> {
    return this.notificationsService.updateSettings(userId, dto);
  }
}
