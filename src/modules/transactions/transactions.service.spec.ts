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
  asset?: string;
  priceAsset?: string;
  exchange?: string;
  timestamp: string;
};

function docFrom(t: RawTrade, i: number) {
  return {
    _id: { toString: () => `id-${i}` },
    exchange: t.exchange ?? 'binance',
    pair: t.pair ?? 'BTC/USDT',
    type: TransactionType.TRADE,
    asset: t.asset ?? 'BTC',
    priceAsset: t.priceAsset ?? 'USDT',
    side: t.side,
    amount: t.amount,
    price: t.price,
    total: t.amount * t.price,
    fee: t.fee,
    feeAsset: t.feeAsset ?? 'USDT',
    timestamp: new Date(t.timestamp),
  };
}

/** What the PnL module booked for a transaction, by its (mock) id. */
type Bookings = Record<string, { kind: 'lot' | 'realized'; amount: number; usdPrice: number }>;

describe('TransactionsService.getTradesByPair', () => {
  let service: TransactionsService;
  let find: jest.Mock;
  let getBookings: jest.Mock;

  const buildService = async (
    raw: RawTrade[],
    { cross = [], bookings = {} }: { cross?: RawTrade[]; bookings?: Bookings } = {},
  ) => {
    const docs = raw.map(docFrom);
    // cross trades get ids after the pair trades, so `id-<n>` stays unique
    const crossDocs = cross.map((t, i) => docFrom(t, raw.length + i));

    // one model, two queries: the pair's own trades ($in) and the asset's
    // trades on other pairs ($nin)
    find = jest.fn((query: { pair?: { $in?: string[]; $nin?: string[] } }) => ({
      sort: () => ({
        exec: () => Promise.resolve(query.pair?.$nin ? crossDocs : docs),
      }),
    }));

    getBookings = jest.fn(async (_user: string, _asset: string, ids: string[]) => {
      const map = new Map();
      for (const id of ids) {
        const b = bookings[id];
        if (b) map.set(id, { ...b, usdTotal: b.amount * b.usdPrice });
      }
      return map;
    });

    const noop = {};
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionsService,
        { provide: getModelToken(Transaction.name), useValue: { find } },
        { provide: ExchangeCredentialsService, useValue: noop },
        { provide: ExchangeFactoryService, useValue: noop },
        { provide: PricesService, useValue: noop },
        { provide: PnlService, useValue: { getBookingsForTransactions: getBookings } },
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

  describe('the asset on other pairs', () => {
    // straight from the user's history: NEXO sold for BTC on Binance, booked
    // by the PnL as a BTC lot at the historical BTC/USD price of that day
    const nexoForBtc: RawTrade = {
      side: 'sell',
      amount: 915.2,
      price: 0.0000122,
      pair: 'NEXO/BTC',
      asset: 'NEXO',
      priceAsset: 'BTC',
      feeAsset: 'BTC',
      timestamp: '2026-03-10',
    };

    it('asks for the trades of the base asset outside the pair', async () => {
      await buildService([]);
      await service.getTradesByPair(USER_ID, 'BTC/USDT');

      expect(find).toHaveBeenCalledWith(
        expect.objectContaining({
          pair: { $nin: expect.arrayContaining(['BTC/USDT', 'BTC/USD']) },
          $or: [{ asset: 'BTC' }, { priceAsset: 'BTC' }],
        }),
      );
    });

    it('transcribes a sale for the base asset into a buy of it, at the USD price the PnL booked', async () => {
      await buildService(
        [{ side: 'buy', amount: 1, price: 100, timestamp: '2026-01-01' }],
        {
          cross: [nexoForBtc],
          bookings: { 'id-1': { kind: 'lot', amount: 0.01116544, usdPrice: 63258.77 } },
        },
      );

      const result = await service.getTradesByPair(USER_ID, 'BTC/USDT');

      expect(getBookings).toHaveBeenCalledWith(USER_ID, 'BTC', ['id-1']);
      expect(result.crossTradeCount).toBe(1);
      expect(result.crossTrades).toHaveLength(1);

      const [cross] = result.crossTrades;
      expect(cross.pair).toBe('NEXO/BTC');
      expect(cross.asset).toBe('NEXO');
      expect(cross.side).toBe('sell');
      expect(cross.amount).toBeCloseTo(915.2, 8);
      expect(cross.priceAsset).toBe('BTC');
      expect(cross.base).toEqual({
        side: 'buy',
        amount: 0.01116544,
        usdPrice: 63258.77,
        usdTotal: expect.closeTo(706.31, 1),
        source: 'lot',
      });
    });

    it('never lets a cross trade move the position of the pair', async () => {
      await buildService(
        [{ side: 'buy', amount: 1, price: 100, timestamp: '2026-01-01' }],
        {
          cross: [nexoForBtc],
          bookings: { 'id-1': { kind: 'lot', amount: 0.01116544, usdPrice: 63258.77 } },
        },
      );

      const { position } = await service.getTradesByPair(USER_ID, 'BTC/USDT');

      expect(position.netAmount).toBeCloseTo(1, 8);
      expect(position.avgEntryPrice).toBeCloseTo(100, 8);
      expect(position.tradeCount).toBe(1);
    });

    it('reads a buy paid with the base asset as a sale of it', async () => {
      await buildService([], {
        cross: [{ ...nexoForBtc, side: 'buy' }],
        bookings: { 'id-0': { kind: 'realized', amount: 0.01116544, usdPrice: 64000 } },
      });

      const [cross] = (await service.getTradesByPair(USER_ID, 'BTC/USDT')).crossTrades;

      expect(cross.base.side).toBe('sell');
      expect(cross.base.source).toBe('realized');
      expect(cross.base.usdPrice).toBe(64000);
    });

    it("keeps the trade's own side when the base asset is the one stored", async () => {
      await buildService([], {
        cross: [
          {
            side: 'buy',
            amount: 0.5,
            price: 15.2,
            pair: 'BTC/ETH',
            asset: 'BTC',
            priceAsset: 'ETH',
            timestamp: '2026-03-10',
          },
        ],
        bookings: { 'id-0': { kind: 'lot', amount: 0.5, usdPrice: 60000 } },
      });

      const [cross] = (await service.getTradesByPair(USER_ID, 'BTC/USDT')).crossTrades;

      expect(cross.base.side).toBe('buy');
      expect(cross.base.amount).toBeCloseTo(0.5, 8);
    });

    it('still lists a trade the PnL never booked, without a USD figure', async () => {
      await buildService([], { cross: [nexoForBtc] });

      const [cross] = (await service.getTradesByPair(USER_ID, 'BTC/USDT')).crossTrades;

      expect(cross.base.side).toBe('buy');
      // amount * price, since there is no lot to read it from
      expect(cross.base.amount).toBeCloseTo(915.2 * 0.0000122, 10);
      expect(cross.base.usdPrice).toBeNull();
      expect(cross.base.usdTotal).toBeNull();
      expect(cross.base.source).toBe('none');
    });

    it('narrows cross trades to the range but counts the whole history', async () => {
      await buildService([], {
        cross: [nexoForBtc, { ...nexoForBtc, timestamp: '2024-01-01' }],
      });

      const result = await service.getTradesByPair(
        USER_ID,
        'BTC/USDT',
        new Date('2026-01-01').getTime(),
        new Date('2026-12-31').getTime(),
      );

      expect(result.crossTrades).toHaveLength(1);
      expect(result.crossTradeCount).toBe(2);
    });
  });
});
