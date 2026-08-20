import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { TransactionsService } from './transactions.service';
import { Transaction } from './schemas/transaction.schema';
import { ExchangeCredentialsService } from '../exchange-credentials/exchange-credentials.service';
import { ExchangeFactoryService } from '../../integrations/exchanges/exchange-factory.service';
import { PricesService } from '../prices/prices.service';
import { PnlService } from '../pnl/pnl.service';
import { SettingsService } from '../settings/settings.service';
import { TransactionType } from '../../common/constants/transaction-types.constant';

const USER_ID = '507f1f77bcf86cd799439011';

type RawTrade = {
  side: string;
  amount: number;
  price: number;
  fee?: number;
  feeAsset?: string;
  pair?: string;
  exchange?: string;
  timestamp: string;
};

function docFrom(t: RawTrade, i: number) {
  return {
    _id: { toString: () => `id-${i}` },
    exchange: t.exchange ?? 'binance',
    pair: t.pair ?? 'BTC/USDT',
    type: TransactionType.TRADE,
    asset: 'BTC',
    side: t.side,
    amount: t.amount,
    price: t.price,
    total: t.amount * t.price,
    fee: t.fee,
    feeAsset: t.feeAsset ?? 'USDT',
    timestamp: new Date(t.timestamp),
  };
}

describe('TransactionsService.getTradesByPair', () => {
  let service: TransactionsService;
  let find: jest.Mock;

  const buildService = async (raw: RawTrade[]) => {
    const docs = raw.map(docFrom);
    find = jest.fn().mockReturnValue({
      sort: () => ({ exec: () => Promise.resolve(docs) }),
    });

    const noop = {};
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionsService,
        { provide: getModelToken(Transaction.name), useValue: { find } },
        { provide: ExchangeCredentialsService, useValue: noop },
        { provide: ExchangeFactoryService, useValue: noop },
        { provide: PricesService, useValue: noop },
        { provide: PnlService, useValue: noop },
        { provide: SettingsService, useValue: noop },
      ],
    }).compile();

    service = module.get<TransactionsService>(TransactionsService);
  };

  it('folds USD-family quotes into a single query', async () => {
    await buildService([]);
    const result = await service.getTradesByPair(USER_ID, 'BTC/USDT');

    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        type: TransactionType.TRADE,
        pair: { $in: expect.arrayContaining(['BTC/USDT', 'BTC/USD']) },
      }),
    );
    expect(result.matchedPairs).toContain('BTC/USD');
  });

  it('computes the weighted moving average position', async () => {
    await buildService([
      {
        side: 'buy',
        amount: 0.0142,
        price: 58120,
        fee: 0.83,
        timestamp: '2026-03-15',
      },
      {
        side: 'buy',
        amount: 0.021,
        price: 61480,
        fee: 1.29,
        timestamp: '2026-04-02',
      },
      {
        side: 'sell',
        amount: 0.008,
        price: 82300,
        fee: 0.66,
        pair: 'BTC/USD',
        exchange: 'kraken',
        timestamp: '2026-05-24',
      },
      {
        side: 'buy',
        amount: 0.0125,
        price: 57800,
        fee: 0.72,
        timestamp: '2026-06-28',
      },
      {
        side: 'buy',
        amount: 0.0064,
        price: 63050,
        fee: 0.4,
        timestamp: '2026-07-19',
      },
    ]);

    const { position } = await service.getTradesByPair(USER_ID, 'BTC/USDT');

    expect(position.netAmount).toBeCloseTo(0.0461, 8);
    expect(position.avgEntryPrice).toBeCloseTo(59960.21, 2);
    expect(position.costBasis).toBeCloseTo(2764.17, 2);
    expect(position.realizedPnl).toBeCloseTo(176.26, 2);
    expect(position.totalBought).toBeCloseTo(0.0541, 8);
    expect(position.totalSold).toBeCloseTo(0.008, 8);
    expect(position.tradeCount).toBe(5);
  });

  it('leaves the average untouched when selling', async () => {
    await buildService([
      { side: 'buy', amount: 1, price: 100, timestamp: '2026-01-01' },
      { side: 'sell', amount: 0.5, price: 300, timestamp: '2026-02-01' },
    ]);

    const { position } = await service.getTradesByPair(USER_ID, 'BTC/USDT');

    expect(position.avgEntryPrice).toBeCloseTo(100, 8);
    expect(position.netAmount).toBeCloseTo(0.5, 8);
    expect(position.realizedPnl).toBeCloseTo(100, 8); // 0.5 * (300 - 100)
  });

  it('discounts a fee charged in the base asset from what was received', async () => {
    await buildService([
      {
        side: 'buy',
        amount: 1,
        price: 100,
        fee: 0.01,
        feeAsset: 'BTC',
        timestamp: '2026-01-01',
      },
    ]);

    const { position } = await service.getTradesByPair(USER_ID, 'BTC/USDT');

    expect(position.netAmount).toBeCloseTo(0.99, 8);
    expect(position.costBasis).toBeCloseTo(100, 8);
  });

  it('does not carry a negative cost when a sale has no matching buy', async () => {
    await buildService([
      { side: 'sell', amount: 1, price: 100, timestamp: '2026-01-01' },
      { side: 'buy', amount: 2, price: 50, timestamp: '2026-02-01' },
    ]);

    const { position } = await service.getTradesByPair(USER_ID, 'BTC/USDT');

    expect(position.netAmount).toBeCloseTo(2, 8);
    expect(position.costBasis).toBeCloseTo(100, 8);
    expect(position.avgEntryPrice).toBeCloseTo(50, 8);
  });

  it('narrows the returned trades to the range but keeps the full position', async () => {
    await buildService([
      { side: 'buy', amount: 1, price: 100, timestamp: '2024-01-01' },
      { side: 'buy', amount: 1, price: 200, timestamp: '2026-06-01' },
    ]);

    const result = await service.getTradesByPair(
      USER_ID,
      'BTC/USDT',
      new Date('2026-01-01').getTime(),
      new Date('2026-12-31').getTime(),
    );

    expect(result.trades).toHaveLength(1);
    expect(result.outsideRange).toBe(1);
    expect(result.position.netAmount).toBeCloseTo(2, 8);
    expect(result.position.avgEntryPrice).toBeCloseTo(150, 8);
  });

  it('ignores trades with no usable price', async () => {
    await buildService([
      { side: 'buy', amount: 1, price: 0, timestamp: '2026-01-01' },
      { side: 'buy', amount: 1, price: 100, timestamp: '2026-02-01' },
    ]);

    const { position } = await service.getTradesByPair(USER_ID, 'BTC/USDT');

    expect(position.netAmount).toBeCloseTo(1, 8);
    expect(position.avgEntryPrice).toBeCloseTo(100, 8);
  });
});
