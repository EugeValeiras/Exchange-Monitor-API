import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PriceHistoryService } from '../modules/prices/price-history.service';

@Injectable()
export class PriceHistoryJob {
  private readonly logger = new Logger(PriceHistoryJob.name);

  constructor(
    private readonly priceHistoryService: PriceHistoryService,
    private readonly configService: ConfigService,
  ) {}

  private isEnabled(): boolean {
    const globalEnabled = this.configService.get<boolean>('crons.enabled', true);
    const jobEnabled = this.configService.get<boolean>('crons.priceHistory', true);
    return globalEnabled && jobEnabled;
  }

  @Cron(CronExpression.EVERY_5_MINUTES, {
    name: 'price-history-capture',
    timeZone: 'UTC',
  })
  async handlePriceCapture(): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.debug('Price history capture job is disabled');
      return;
    }
    this.logger.log('Starting price history capture...');

    try {
      const capturedCount =
        await this.priceHistoryService.captureCurrentPrices();
      this.logger.log(`Price history capture completed: ${capturedCount} records saved`);
    } catch (error) {
      this.logger.error(
        `Price history capture failed: ${error.message}`,
        error.stack,
      );
    }
  }
}
