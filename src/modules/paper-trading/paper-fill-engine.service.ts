import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PricesService } from '../prices/prices.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PaperTradingService } from './paper-trading.service';
import { PaperAccountDocument } from './schemas/paper-account.schema';

@Injectable()
export class PaperFillEngineService {
  private readonly logger = new Logger(PaperFillEngineService.name);
  // In-process guard against overlapping cron cycles (slow cycles only).
  // Cross-instance safety does not depend on this flag: processOpenOrder
  // claims each order atomically (open -> filled via findOneAndUpdate),
  // so concurrent engines/replicas can never double-fill an order.
  private processing = false;

  constructor(
    private readonly paperTradingService: PaperTradingService,
    private readonly pricesService: PricesService,
    private readonly configService: ConfigService,
    @Optional() private readonly notificationsService?: NotificationsService,
  ) {}

  private isEnabled(): boolean {
    const globalEnabled = this.configService.get<boolean>(
      'crons.enabled',
      true,
    );
    const jobEnabled = this.configService.get<boolean>(
      'crons.paperTrading',
      true,
    );
    return globalEnabled && jobEnabled;
  }

  @Cron(CronExpression.EVERY_10_SECONDS, {
    name: 'paper-trading-fill-engine',
    timeZone: 'UTC',
  })
  async handleFillCycle(): Promise<void> {
    if (!this.isEnabled() || this.processing) {
      return;
    }
    this.processing = true;

    try {
      const openOrders = await this.paperTradingService.findOpenOrders();
      if (openOrders.length === 0) {
        return;
      }

      // One price fetch per symbol
      const baseAssets = Array.from(
        new Set(openOrders.map((order) => order.symbol.split('/')[0])),
      );
      const pricesMap = await this.pricesService.getPricesMap(baseAssets);

      const accountsCache = new Map<string, PaperAccountDocument | null>();
      let filled = 0;

      // Sequential processing per account (orders come sorted by accountId)
      for (const order of openOrders) {
        const base = order.symbol.split('/')[0];
        const price = pricesMap[base];
        if (!price || price <= 0) {
          // No price for this symbol: skip this cycle
          continue;
        }

        const accountKey = order.accountId.toString();
        let account = accountsCache.get(accountKey);
        if (account === undefined) {
          account =
            (await this.paperTradingService.findAccountById(
              order.accountId,
            )) ?? null;
          accountsCache.set(accountKey, account);
        }
        // Inactive (or deleted) accounts must not keep filling orders:
        // equity snapshots only cover active accounts, so fills here would
        // mutate balances without the equity curve ever registering them.
        if (!account || !account.isActive) continue;

        try {
          const didFill = await this.paperTradingService.processOpenOrder(
            order,
            account,
            price,
          );
          if (didFill) {
            filled++;
            await this.notifyFill(order, price);
          }
        } catch (error) {
          this.logger.error(
            `Failed to process paper order ${order._id}: ${error.message}`,
            error.stack,
          );
        }
      }

      if (filled > 0) {
        this.logger.log(`Paper fill engine: ${filled} order(s) filled`);
      }
    } catch (error) {
      this.logger.error(
        `Paper fill engine cycle failed: ${error.message}`,
        error.stack,
      );
    } finally {
      this.processing = false;
    }
  }

  @Cron('0 */15 * * * *', {
    name: 'paper-trading-equity-snapshot',
    timeZone: 'UTC',
  })
  async handleEquitySnapshots(): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }
    try {
      const count = await this.paperTradingService.captureEquitySnapshots();
      if (count > 0) {
        this.logger.log(`Paper equity snapshots captured: ${count} accounts`);
      }
    } catch (error) {
      this.logger.error(
        `Paper equity snapshot failed: ${error.message}`,
        error.stack,
      );
    }
  }

  private async notifyFill(order: any, price: number): Promise<void> {
    if (!this.notificationsService) {
      return;
    }
    try {
      const title = `Paper order filled: ${order.symbol}`;
      const body = `${order.side.toUpperCase()} ${order.amount} ${order.symbol.split('/')[0]} @ ${order.filledPrice?.toFixed(2) ?? price.toFixed(2)} USDT (${order.type})`;
      await this.notificationsService.sendToUser(
        order.userId.toString(),
        title,
        body,
        { type: 'paper_order_filled', orderId: order._id.toString() },
      );
    } catch (error) {
      this.logger.warn(`Failed to send fill notification: ${error.message}`);
    }
  }
}
