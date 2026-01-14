import { Injectable } from '@nestjs/common';
import { IExchangeAdapter } from '../../common/interfaces/exchange-adapter.interface';
import { ExchangeType } from '../../common/constants/exchanges.constant';
import { KrakenAdapter } from './kraken/kraken.adapter';
import { BinanceAdapter } from './binance/binance.adapter';
import { NexoAdapter } from './nexo/nexo.adapter';
import {
  NexoManualAdapter,
  TransactionsFetcher,
} from './nexo-manual/nexo-manual.adapter';

@Injectable()
export class ExchangeFactoryService {
  createAdapter(
    exchange: ExchangeType,
    apiKey: string,
    apiSecret: string,
    _passphrase?: string,
  ): IExchangeAdapter {
    switch (exchange) {
      case ExchangeType.KRAKEN:
        return new KrakenAdapter(apiKey, apiSecret);
      case ExchangeType.BINANCE:
        return new BinanceAdapter(apiKey, apiSecret);
      case ExchangeType.NEXO_PRO:
        return new NexoAdapter(apiKey, apiSecret);
      case ExchangeType.NEXO_MANUAL:
        throw new Error(
          'NEXO_MANUAL requires a transactions fetcher. Use createNexoManualAdapter instead.',
        );
      default:
        throw new Error(`Unsupported exchange: ${exchange}`);
    }
  }

  createNexoManualAdapter(fetchTransactions: TransactionsFetcher): IExchangeAdapter {
    return new NexoManualAdapter(fetchTransactions);
  }
}
