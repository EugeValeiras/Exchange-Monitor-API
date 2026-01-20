import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { WellKnownController } from './well-known.controller';
import { AuthService } from './auth.service';
import { PasskeyService } from './passkey.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    UsersModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get<string>('jwt.secret'),
        signOptions: {
          expiresIn: 604800, // 7 days in seconds
        },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [AuthController, WellKnownController],
  providers: [AuthService, PasskeyService, JwtStrategy],
  exports: [AuthService, PasskeyService],
})
export class AuthModule {}
