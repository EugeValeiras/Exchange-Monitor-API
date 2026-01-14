import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { TransactionsService } from '../modules/transactions/transactions.service';
import { ExchangeCredentialsService } from '../modules/exchange-credentials/exchange-credentials.service';

@Injectable()
export class SyncTransactionsJob {
  private readonly logger = new Logger(SyncTransactionsJob.name);

  constructor(
    private readonly transactionsService: TransactionsService,
    private readonly credentialsService: ExchangeCredentialsService,
  ) {}

  @Cron('0 */6 * * *', {
    name: 'sync-transactions',
    timeZone: 'UTC',
  })
  async handleTransactionSync(): Promise<void> {
    this.logger.log('Starting transaction sync job...');

    try {
      const credentials = await this.credentialsService.findAllActive();

      let syncedCount = 0;
      let errorCount = 0;

      for (const credential of credentials) {
        try {
          const newTransactions = await this.transactionsService.syncFromExchange(
            credential._id,
          );
          syncedCount += newTransactions;

          await this.credentialsService.updateLastSync(credential._id);
        } catch (error) {
          errorCount++;
          this.logger.warn(
            `Sync failed for credential ${credential._id}: ${error.message}`,
          );

          await this.credentialsService.updateLastError(
            credential._id,
            error.message,
          );
        }
      }

      this.logger.log(
        `Transaction sync completed. Synced: ${syncedCount} new transactions, Errors: ${errorCount}`,
      );
    } catch (error) {
      this.logger.error(
        `Transaction sync job failed: ${error.message}`,
        error.stack,
      );
    }
  }
}
