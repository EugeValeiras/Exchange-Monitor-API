import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsEmail, IsOptional, IsObject } from 'class-validator';

export class RegisterPasskeyChallengeResponseDto {
  @ApiProperty({ description: 'WebAuthn registration options' })
  options: any;

  @ApiProperty({ description: 'Challenge string' })
  challenge: string;
}

export class VerifyPasskeyRegistrationDto {
  @ApiProperty({ description: 'WebAuthn registration response from client' })
  @IsObject()
  response: any;

  @ApiPropertyOptional({ description: 'Device name (e.g., "iPhone 15")' })
  @IsOptional()
  @IsString()
  deviceName?: string;
}

export class PasskeyRegistrationResultDto {
  @ApiProperty({ description: 'Success status' })
  success: boolean;

  @ApiProperty({ description: 'Credential ID' })
  credentialId: string;

  @ApiProperty({ description: 'Device name' })
  deviceName: string;

  @ApiProperty({ description: 'Creation date' })
  createdAt: Date;
}

export class AuthPasskeyChallengeDto {
  @ApiPropertyOptional({ description: 'User email (optional for discoverable credentials)' })
  @IsOptional()
  @IsEmail()
  email?: string;
}

export class AuthPasskeyChallengeResponseDto {
  @ApiProperty({ description: 'WebAuthn authentication options' })
  options: any;

  @ApiProperty({ description: 'Challenge string' })
  challenge: string;
}

export class VerifyPasskeyAuthenticationDto {
  @ApiPropertyOptional({ description: 'User email (optional for discoverable credentials)' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiProperty({ description: 'WebAuthn authentication response from client' })
  @IsObject()
  response: any;
}

export class PasskeyListItemDto {
  @ApiProperty({ description: 'Credential ID' })
  id: string;

  @ApiProperty({ description: 'Device name' })
  deviceName: string;

  @ApiProperty({ description: 'Creation date' })
  createdAt: Date;

  @ApiPropertyOptional({ description: 'Last used date' })
  lastUsedAt?: Date;
}

export class PasskeyListResponseDto {
  @ApiProperty({ type: [PasskeyListItemDto], description: 'List of passkeys' })
  passkeys: PasskeyListItemDto[];
}
