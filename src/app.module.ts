import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import configuration from './config/configuration';

// Core modules
import { EncryptionModule } from './integrations/encryption/encryption.module';
import { ExchangesModule } from './integrations/exchanges/exchanges.module';

// Feature modules
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { ExchangeCredentialsModule } from './modules/exchange-credentials/exchange-credentials.module';
import { BalancesModule } from './modules/balances/balances.module';
import { TransactionsModule } from './modules/transactions/transactions.module';
import { ImportsModule } from './modules/imports/imports.module';
import { PricesModule } from './modules/prices/prices.module';
import { SnapshotsModule } from './modules/snapshots/snapshots.module';
import { SettingsModule } from './modules/settings/settings.module';
import { PnlModule } from './modules/pnl/pnl.module';
import { JobsModule } from './jobs/jobs.module';

@Module({
  imports: [
    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),

    // Database
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        uri: configService.get<string>('database.uri'),
      }),
      inject: [ConfigService],
    }),

    // Core
    EncryptionModule,
    ExchangesModule,

    // Auth & Users
    AuthModule,
    UsersModule,

    // Features
    ExchangeCredentialsModule,
    BalancesModule,
    TransactionsModule,
    ImportsModule,
    PricesModule,
    SnapshotsModule,
    SettingsModule,
    PnlModule,

    // Jobs
    JobsModule,
  ],
})
export class AppModule {}
