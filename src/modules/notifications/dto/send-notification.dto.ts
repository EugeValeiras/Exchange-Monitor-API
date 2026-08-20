import { IsString, IsNotEmpty, IsOptional, IsObject } from 'class-validator';

export class SendNotificationDto {
  @IsString()
  @IsNotEmpty()
  title: string;

  @IsString()
  @IsNotEmpty()
  body: string;

  // Optional arbitrary data payload (e.g. routing/deep-link info for the app).
  // Values must be strings — FCM only accepts string values in the data map.
  @IsOptional()
  @IsObject()
  data?: Record<string, string>;
}

export class SendNotificationResponseDto {
  success: boolean;
  successCount: number;
  totalTokens: number;
}
