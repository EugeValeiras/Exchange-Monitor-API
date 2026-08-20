import { BadRequestException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Types } from 'mongoose';
import { PricesService } from '../prices/prices.service';
import { PaperTradingService } from './paper-trading.service';
import { PaperAccount } from './schemas/paper-account.schema';
import { PaperOrder } from './schemas/paper-order.schema';
import { PaperPosition } from './schemas/paper-position.schema';
import { PaperEquitySnapshot } from './schemas/paper-equity-snapshot.schema';
import {
  PaperOrderSide,
  PaperOrderStatus,
  PaperOrderType,
} from './dto/paper-order.enums';

describe('PaperTradingService (engine math)', () => {
  let service: PaperTradingService;
  let pricesMap: Record<string, number>;
  let positions: Map<string, any>;
  let accountDoc: any;
  let orderDocs: Map<string, any>;
  let eventEmitter: { emit: jest.Mock };

  const userId = new Types.ObjectId().toString();

  const getPath = (obj: any, path: string): any =>
    path.split('.').reduce((o, key) => (o == null ? undefined : o[key]), obj);

  const setPath = (obj: any, path: string, value: any): void => {
    const keys = path.split('.');
    let target = obj;
    for (const key of keys.slice(0, -1)) {
      if (target[key] == null) target[key] = {};
      target = target[key];
    }
    target[keys[keys.length - 1]] = value;
  };

  const makeDoc = (data: any): any => {
    const doc: any = {
      _id: data._id ?? new Types.ObjectId(),
      ...data,
      markModified: jest.fn(),
      deleteOne: jest.fn(),
    };
    doc.save = jest.fn().mockImplementation(async () => doc);
    return doc;
  };

  const makeAccount = (overrides: any = {}): any =>
    makeDoc({
      userId: new Types.ObjectId(userId),
      name: 'default',
      initialBalance: 10000,
      feeRate: 0.001,
      slippageBps: 5,
      balances: { USDT: { free: 10000, locked: 0 } },
      isActive: true,
      ...overrides,
    });

  const positionKey = (accountId: any, asset: string) =>
    `${accountId.toString()}|${asset}`;

  beforeEach(async () => {
    pricesMap = {};
    positions = new Map();
    accountDoc = makeAccount();
    orderDocs = new Map();
    eventEmitter = { emit: jest.fn() };

    const accountModelMock: any = jest.fn();
    accountModelMock.findOne = jest.fn(() => ({
      exec: jest.fn().mockResolvedValue(accountDoc),
    }));
    accountModelMock.findById = jest.fn(() => ({
      exec: jest.fn().mockResolvedValue(accountDoc),
    }));
    // Emulates the atomic $inc-with-conditions balance update
    accountModelMock.findOneAndUpdate = jest.fn(
      (filter: any, update: any) => ({
        exec: jest.fn().mockImplementation(async () => {
          for (const [key, cond] of Object.entries<any>(filter)) {
            if (key === '_id') continue;
            if (cond && typeof cond === 'object' && '$gte' in cond) {
              const current = getPath(accountDoc, key);
              if (typeof current !== 'number' || current < cond.$gte) {
                return null;
              }
            }
          }
          for (const [key, delta] of Object.entries<any>(
            update?.$inc ?? {},
          )) {
            setPath(accountDoc, key, (getPath(accountDoc, key) ?? 0) + delta);
          }
          return accountDoc;
        }),
      }),
    );

    const orderModelMock: any = jest
      .fn()
      .mockImplementation((data: any) => makeDoc(data));
    orderModelMock.findOne = jest.fn();
    // Emulates the atomic open -> filled/canceled claim (returns pre-image)
    orderModelMock.findOneAndUpdate = jest.fn((filter: any, update: any) => ({
      exec: jest.fn().mockImplementation(async () => {
        const doc = orderDocs.get(filter._id?.toString());
        if (!doc) return null;
        if (filter.status && doc.status !== filter.status) return null;
        // ocoPartnerId: null in the filter matches only an unlinked doc
        if (filter.ocoPartnerId === null && doc.ocoPartnerId != null) {
          return null;
        }
        const snapshot = { ...doc };
        if (update?.$set) Object.assign(doc, update.$set);
        if (update?.$unset) {
          for (const key of Object.keys(update.$unset)) {
            doc[key] = undefined;
          }
        }
        return snapshot;
      }),
    }));

    const positionModelMock: any = jest
      .fn()
      .mockImplementation((data: any) => {
        const doc = makeDoc(data);
        doc.save = jest.fn().mockImplementation(async () => {
          positions.set(positionKey(doc.accountId, doc.asset), doc);
          return doc;
        });
        return doc;
      });
    positionModelMock.findOne = jest.fn(({ accountId, asset }: any) => ({
      exec: jest
        .fn()
        .mockResolvedValue(positions.get(positionKey(accountId, asset)) ?? null),
    }));

    accountModelMock.find = jest.fn(() => ({
      exec: jest.fn().mockResolvedValue([accountDoc]),
    }));

    const snapshotModelMock: any = jest.fn();
    snapshotModelMock.insertMany = jest.fn().mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaperTradingService,
        { provide: getModelToken(PaperAccount.name), useValue: accountModelMock },
        { provide: getModelToken(PaperOrder.name), useValue: orderModelMock },
        {
          provide: getModelToken(PaperPosition.name),
          useValue: positionModelMock,
        },
        {
          provide: getModelToken(PaperEquitySnapshot.name),
          useValue: snapshotModelMock,
        },
        {
          provide: PricesService,
          useValue: {
            getPricesMap: jest.fn(async (assets: string[]) => {
              const result: Record<string, number> = {};
              for (const asset of assets) {
                result[asset] = pricesMap[asset] ?? 0;
              }
              return result;
            }),
          },
        },
        { provide: EventEmitter2, useValue: eventEmitter },
      ],
    }).compile();

    service = module.get<PaperTradingService>(PaperTradingService);
  });

  const baseOrderDto = (overrides: any = {}): any => ({
    accountId: accountDoc._id.toString(),
    symbol: 'BTC/USDT',
    side: PaperOrderSide.BUY,
    type: PaperOrderType.MARKET,
    amount: 0.1,
    ...overrides,
  });

  describe('market fills (slippage + fee)', () => {
    it('fills a market buy at price * (1 + slippage) and charges fee in USDT', async () => {
      pricesMap.BTC = 50000;

      const order = await service.createOrder(userId, baseOrderDto());

      const expectedFillPrice = 50000 * 1.0005; // 5 bps
      const notional = 0.1 * expectedFillPrice;
      const fee = 0.001 * notional;

      expect(order.status).toBe(PaperOrderStatus.FILLED);
      expect(order.filledPrice).toBeCloseTo(expectedFillPrice, 8);
      expect(order.fee).toBeCloseTo(fee, 8);
      expect(order.feeAsset).toBe('USDT');
      expect(accountDoc.balances.USDT.free).toBeCloseTo(
        10000 - notional - fee,
        8,
      );
      expect(accountDoc.balances.BTC.free).toBeCloseTo(0.1, 12);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'paper.order.filled',
        expect.objectContaining({ userId }),
      );
    });

    it('fills a market sell at price * (1 - slippage)', async () => {
      pricesMap.BTC = 50000;
      accountDoc.balances.BTC = { free: 1, locked: 0 };

      const order = await service.createOrder(
        userId,
        baseOrderDto({ side: PaperOrderSide.SELL, amount: 0.5 }),
      );

      const expectedFillPrice = 50000 * 0.9995;
      const notional = 0.5 * expectedFillPrice;
      const fee = 0.001 * notional;

      expect(order.status).toBe(PaperOrderStatus.FILLED);
      expect(order.filledPrice).toBeCloseTo(expectedFillPrice, 8);
      expect(accountDoc.balances.BTC.free).toBeCloseTo(0.5, 12);
      expect(accountDoc.balances.USDT.free).toBeCloseTo(
        10000 + notional - fee,
        8,
      );
    });

    it('converts quoteAmount to base amount at the fill price', async () => {
      pricesMap.BTC = 50000;

      const order = await service.createOrder(
        userId,
        baseOrderDto({ amount: undefined, quoteAmount: 1000 }),
      );

      const expectedFillPrice = 50000 * 1.0005;
      expect(order.amount).toBeCloseTo(1000 / expectedFillPrice, 12);
    });
  });

  describe('average cost position accounting', () => {
    it('computes weighted average entry price on successive buys', async () => {
      accountDoc.slippageBps = 0;
      accountDoc.feeRate = 0;

      pricesMap.ETH = 100;
      await service.createOrder(
        userId,
        baseOrderDto({ symbol: 'ETH/USDT', amount: 1 }),
      );

      pricesMap.ETH = 200;
      await service.createOrder(
        userId,
        baseOrderDto({ symbol: 'ETH/USDT', amount: 1 }),
      );

      const position = positions.get(positionKey(accountDoc._id, 'ETH'));
      expect(position.amount).toBeCloseTo(2, 12);
      expect(position.avgEntryPrice).toBeCloseTo(150, 8); // (100 + 200) / 2
    });

    it('accumulates realizedPnl on sells without changing avg entry', async () => {
      accountDoc.slippageBps = 0;

      pricesMap.ETH = 100;
      await service.createOrder(
        userId,
        baseOrderDto({ symbol: 'ETH/USDT', amount: 1 }),
      );

      pricesMap.ETH = 150;
      const sellOrder = await service.createOrder(
        userId,
        baseOrderDto({
          symbol: 'ETH/USDT',
          side: PaperOrderSide.SELL,
          amount: 0.5,
        }),
      );

      const position = positions.get(positionKey(accountDoc._id, 'ETH'));
      const sellFee = 0.001 * 0.5 * 150;
      // (150 - 100) * 0.5 - fee
      expect(position.realizedPnl).toBeCloseTo(25 - sellFee, 8);
      expect(position.amount).toBeCloseTo(0.5, 12);
      expect(position.avgEntryPrice).toBeCloseTo(100, 8);
      expect(sellOrder.realizedPnl).toBeCloseTo(25 - sellFee, 8);
    });
  });

  describe('limit orders: locked funds and cancelation', () => {
    it('locks USDT (notional + fee) for a non-marketable limit buy', async () => {
      pricesMap.BTC = 100;

      const order = await service.createOrder(
        userId,
        baseOrderDto({
          type: PaperOrderType.LIMIT,
          amount: 1,
          limitPrice: 90,
        }),
      );

      const expectedLock = 1 * 90 * 1.001;
      expect(order.status).toBe(PaperOrderStatus.OPEN);
      expect(accountDoc.balances.USDT.locked).toBeCloseTo(expectedLock, 8);
      expect(accountDoc.balances.USDT.free).toBeCloseTo(
        10000 - expectedLock,
        8,
      );
    });

    it('locks base asset for a non-marketable limit sell', async () => {
      pricesMap.BTC = 100;
      accountDoc.balances.BTC = { free: 2, locked: 0 };

      const order = await service.createOrder(
        userId,
        baseOrderDto({
          type: PaperOrderType.LIMIT,
          side: PaperOrderSide.SELL,
          amount: 1,
          limitPrice: 120,
        }),
      );

      expect(order.status).toBe(PaperOrderStatus.OPEN);
      expect(accountDoc.balances.BTC.locked).toBeCloseTo(1, 12);
      expect(accountDoc.balances.BTC.free).toBeCloseTo(1, 12);
    });

    it('releases locked funds when canceling an open order', async () => {
      pricesMap.BTC = 100;
      const created = await service.createOrder(
        userId,
        baseOrderDto({
          type: PaperOrderType.LIMIT,
          amount: 1,
          limitPrice: 90,
        }),
      );

      // Wire up findOne for cancelOrder lookup
      const orderModel: any = (service as any).orderModel;
      const orderDoc = makeDoc({
        _id: new Types.ObjectId(created.id),
        userId: new Types.ObjectId(userId),
        accountId: accountDoc._id,
        symbol: 'BTC/USDT',
        side: PaperOrderSide.BUY,
        type: PaperOrderType.LIMIT,
        status: PaperOrderStatus.OPEN,
        amount: 1,
        limitPrice: 90,
        lockedAmount: 1 * 90 * 1.001,
        lockedAsset: 'USDT',
      });
      orderModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue(orderDoc),
      });
      orderDocs.set(orderDoc._id.toString(), orderDoc);

      const canceled = await service.cancelOrder(userId, created.id);

      expect(canceled.status).toBe(PaperOrderStatus.CANCELED);
      expect(accountDoc.balances.USDT.locked).toBeCloseTo(0, 8);
      expect(accountDoc.balances.USDT.free).toBeCloseTo(10000, 8);
    });

    it('fills a marketable limit buy immediately at the slipped current price', async () => {
      pricesMap.BTC = 100;

      const order = await service.createOrder(
        userId,
        baseOrderDto({
          type: PaperOrderType.LIMIT,
          amount: 1,
          limitPrice: 110,
        }),
      );

      expect(order.status).toBe(PaperOrderStatus.FILLED);
      expect(order.filledPrice).toBeCloseTo(100 * 1.0005, 8);
    });
  });

  describe('triggers (evaluateTrigger)', () => {
    const account = { slippageBps: 5 };

    it('limit buy fills at exact limitPrice when price <= limitPrice (maker, no slippage)', () => {
      const order = {
        type: PaperOrderType.LIMIT,
        side: PaperOrderSide.BUY,
        limitPrice: 90,
      } as any;
      expect(service.evaluateTrigger(order, account, 89)).toBe(90);
      expect(service.evaluateTrigger(order, account, 91)).toBeNull();
    });

    it('limit sell fills at exact limitPrice when price >= limitPrice', () => {
      const order = {
        type: PaperOrderType.LIMIT,
        side: PaperOrderSide.SELL,
        limitPrice: 120,
      } as any;
      expect(service.evaluateTrigger(order, account, 121)).toBe(120);
      expect(service.evaluateTrigger(order, account, 119)).toBeNull();
    });

    it('stop_loss sell triggers when price <= stopPrice and fills with sell slippage', () => {
      const order = {
        type: PaperOrderType.STOP_LOSS,
        side: PaperOrderSide.SELL,
        stopPrice: 80,
      } as any;
      expect(service.evaluateTrigger(order, account, 79)).toBeCloseTo(
        79 * 0.9995,
        10,
      );
      expect(service.evaluateTrigger(order, account, 81)).toBeNull();
    });

    it('stop_loss buy triggers when price >= stopPrice and fills with buy slippage', () => {
      const order = {
        type: PaperOrderType.STOP_LOSS,
        side: PaperOrderSide.BUY,
        stopPrice: 110,
      } as any;
      expect(service.evaluateTrigger(order, account, 111)).toBeCloseTo(
        111 * 1.0005,
        10,
      );
      expect(service.evaluateTrigger(order, account, 109)).toBeNull();
    });

    it('take_profit sell triggers when price >= stopPrice', () => {
      const order = {
        type: PaperOrderType.TAKE_PROFIT,
        side: PaperOrderSide.SELL,
        stopPrice: 120,
      } as any;
      expect(service.evaluateTrigger(order, account, 121)).toBeCloseTo(
        121 * 0.9995,
        10,
      );
      expect(service.evaluateTrigger(order, account, 119)).toBeNull();
    });

    it('take_profit buy triggers when price <= stopPrice', () => {
      const order = {
        type: PaperOrderType.TAKE_PROFIT,
        side: PaperOrderSide.BUY,
        stopPrice: 90,
      } as any;
      expect(service.evaluateTrigger(order, account, 89)).toBeCloseTo(
        89 * 1.0005,
        10,
      );
      expect(service.evaluateTrigger(order, account, 91)).toBeNull();
    });
  });

  describe('processOpenOrder (fill engine)', () => {
    it('fills an open limit sell at the limit price and releases the lock', async () => {
      accountDoc.balances.BTC = { free: 0, locked: 1 };

      const orderDoc = makeDoc({
        userId: new Types.ObjectId(userId),
        accountId: accountDoc._id,
        symbol: 'BTC/USDT',
        side: PaperOrderSide.SELL,
        type: PaperOrderType.LIMIT,
        status: PaperOrderStatus.OPEN,
        amount: 1,
        limitPrice: 120,
        requestedPrice: 100,
        lockedAmount: 1,
        lockedAsset: 'BTC',
      });
      orderDocs.set(orderDoc._id.toString(), orderDoc);

      const filled = await service.processOpenOrder(orderDoc, accountDoc, 125);

      expect(filled).toBe(true);
      expect(orderDoc.status).toBe(PaperOrderStatus.FILLED);
      expect(orderDoc.filledPrice).toBe(120); // maker fill, no slippage
      const fee = 0.001 * 120;
      expect(accountDoc.balances.BTC.locked).toBeCloseTo(0, 12);
      expect(accountDoc.balances.BTC.free).toBeCloseTo(0, 12);
      expect(accountDoc.balances.USDT.free).toBeCloseTo(10000 + 120 - fee, 8);
      expect(eventEmitter.emit).toHaveBeenCalled();
    });

    it('does not fill when the trigger condition is not met', async () => {
      accountDoc.balances.BTC = { free: 0, locked: 1 };
      const orderDoc = makeDoc({
        userId: new Types.ObjectId(userId),
        accountId: accountDoc._id,
        symbol: 'BTC/USDT',
        side: PaperOrderSide.SELL,
        type: PaperOrderType.LIMIT,
        status: PaperOrderStatus.OPEN,
        amount: 1,
        limitPrice: 120,
        requestedPrice: 100,
        lockedAmount: 1,
        lockedAsset: 'BTC',
      });
      orderDocs.set(orderDoc._id.toString(), orderDoc);

      const filled = await service.processOpenOrder(orderDoc, accountDoc, 110);

      expect(filled).toBe(false);
      expect(orderDoc.status).toBe(PaperOrderStatus.OPEN);
      expect(accountDoc.balances.BTC.locked).toBeCloseTo(1, 12);
    });

    it('does not fill an order that was canceled concurrently (stale snapshot)', async () => {
      accountDoc.balances.BTC = { free: 0, locked: 1 };

      // The engine holds a stale OPEN snapshot, but the DB doc is CANCELED
      const staleDoc = makeDoc({
        userId: new Types.ObjectId(userId),
        accountId: accountDoc._id,
        symbol: 'BTC/USDT',
        side: PaperOrderSide.SELL,
        type: PaperOrderType.LIMIT,
        status: PaperOrderStatus.OPEN,
        amount: 1,
        limitPrice: 120,
        requestedPrice: 100,
        lockedAmount: 1,
        lockedAsset: 'BTC',
      });
      orderDocs.set(staleDoc._id.toString(), {
        ...staleDoc,
        status: PaperOrderStatus.CANCELED,
      });

      const filled = await service.processOpenOrder(staleDoc, accountDoc, 125);

      expect(filled).toBe(false);
      // Balances untouched: no fill, no double lock release
      expect(accountDoc.balances.BTC.locked).toBeCloseTo(1, 12);
      expect(accountDoc.balances.USDT.free).toBeCloseTo(10000, 8);
      expect(staleDoc.save).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('clamps a triggered stop buy to the locked funds when the price overshoots', async () => {
      const stopPrice = 100;
      const lockAmount = 1 * stopPrice * 1.001 * 1.0005; // fee + slippage
      accountDoc.balances.USDT = { free: 0, locked: lockAmount };

      const orderDoc = makeDoc({
        userId: new Types.ObjectId(userId),
        accountId: accountDoc._id,
        symbol: 'BTC/USDT',
        side: PaperOrderSide.BUY,
        type: PaperOrderType.STOP_LOSS,
        status: PaperOrderStatus.OPEN,
        amount: 1,
        stopPrice,
        requestedPrice: 90,
        lockedAmount: lockAmount,
        lockedAsset: 'USDT',
      });
      orderDocs.set(orderDoc._id.toString(), orderDoc);

      // Price overshot the stop: cost at fill > locked amount
      const filled = await service.processOpenOrder(orderDoc, accountDoc, 105);

      expect(filled).toBe(true);
      expect(orderDoc.status).toBe(PaperOrderStatus.FILLED);
      expect(orderDoc.amount).toBeLessThan(1);
      expect(orderDoc.amount).toBeGreaterThan(0.9);
      expect(accountDoc.balances.USDT.locked).toBeCloseTo(0, 8);
      expect(accountDoc.balances.USDT.free).toBeGreaterThanOrEqual(0);
      expect(accountDoc.balances.BTC.free).toBeCloseTo(orderDoc.amount, 12);
    });
  });

  describe('captureEquitySnapshots', () => {
    it('skips accounts holding assets without a current price', async () => {
      accountDoc.balances.BTC = { free: 1, locked: 0 };
      // pricesMap.BTC not set -> 0

      const count = await service.captureEquitySnapshots();

      expect(count).toBe(0);
      const snapshotModel: any = (service as any).snapshotModel;
      expect(snapshotModel.insertMany).not.toHaveBeenCalled();
    });

    it('captures equity when all held assets have prices', async () => {
      accountDoc.balances.BTC = { free: 1, locked: 0 };
      pricesMap.BTC = 50000;

      const count = await service.captureEquitySnapshots();

      expect(count).toBe(1);
      const snapshotModel: any = (service as any).snapshotModel;
      expect(snapshotModel.insertMany).toHaveBeenCalledWith([
        expect.objectContaining({ equity: 10000 + 50000 }),
      ]);
    });
  });

  describe('stop/take-profit buy locks include slippage', () => {
    it('locks amount * stopPrice * (1 + fee) * (1 + slippage) for a stop buy', async () => {
      pricesMap.BTC = 100;

      const order = await service.createOrder(
        userId,
        baseOrderDto({
          type: PaperOrderType.STOP_LOSS,
          amount: 1,
          stopPrice: 110,
        }),
      );

      const expectedLock = 1 * 110 * 1.001 * 1.0005;
      expect(order.status).toBe(PaperOrderStatus.OPEN);
      expect(accountDoc.balances.USDT.locked).toBeCloseTo(expectedLock, 8);
      expect(accountDoc.balances.USDT.free).toBeCloseTo(
        10000 - expectedLock,
        8,
      );
    });

    it('keeps the exact maker lock (no slippage) for limit buys', async () => {
      pricesMap.BTC = 100;

      await service.createOrder(
        userId,
        baseOrderDto({
          type: PaperOrderType.LIMIT,
          amount: 1,
          limitPrice: 90,
        }),
      );

      expect(accountDoc.balances.USDT.locked).toBeCloseTo(90 * 1.001, 8);
    });
  });

  describe('rejections', () => {
    it('rejects a market buy with insufficient USDT balance', async () => {
      pricesMap.BTC = 50000;
      accountDoc.balances.USDT.free = 100;

      await expect(
        service.createOrder(userId, baseOrderDto({ amount: 1 })),
      ).rejects.toThrow(BadRequestException);
      // Nothing persisted
      expect(accountDoc.save).not.toHaveBeenCalled();
    });

    it('rejects a market sell with insufficient base balance', async () => {
      pricesMap.BTC = 50000;

      await expect(
        service.createOrder(
          userId,
          baseOrderDto({ side: PaperOrderSide.SELL, amount: 1 }),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects orders below the 5 USDT min notional', async () => {
      pricesMap.BTC = 50000;

      await expect(
        service.createOrder(userId, baseOrderDto({ amount: 0.00009 })),
      ).rejects.toThrow(/min/i);
    });

    it('rejects a limit buy when free USDT cannot cover the lock', async () => {
      pricesMap.BTC = 100;
      accountDoc.balances.USDT.free = 50;

      await expect(
        service.createOrder(
          userId,
          baseOrderDto({
            type: PaperOrderType.LIMIT,
            amount: 1,
            limitPrice: 90,
          }),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a market order when no price is available', async () => {
      // pricesMap.BTC not set -> 0
      await expect(
        service.createOrder(userId, baseOrderDto()),
      ).rejects.toThrow(/price/i);
    });

    it('rejects non-USDT quoted symbols', async () => {
      pricesMap.BTC = 50000;
      await expect(
        service.createOrder(userId, baseOrderDto({ symbol: 'BTC/EUR' })),
      ).rejects.toThrow(/USDT/);
    });

    it('rejects when both amount and quoteAmount are provided', async () => {
      pricesMap.BTC = 50000;
      await expect(
        service.createOrder(
          userId,
          baseOrderDto({ amount: 0.1, quoteAmount: 1000 }),
        ),
      ).rejects.toThrow(/exactly one/i);
    });
  });

  describe('OCO orders (one-cancels-other)', () => {
    let orderModel: any;
    let accountModel: any;

    beforeEach(() => {
      orderModel = (service as any).orderModel;
      accountModel = (service as any).accountModel;
      pricesMap.BTC = 100;
      // The primary leg already locked the full base asset
      accountDoc.balances.BTC = { free: 0, locked: 1 };
      // Resolve getOrderDoc lookups and the post-save link re-check
      // against the shared orderDocs map, honoring status/ocoPartnerId
      // filter conditions
      orderModel.findOne.mockImplementation((filter: any) => ({
        exec: jest.fn().mockImplementation(async () => {
          const doc = orderDocs.get(filter._id?.toString()) ?? null;
          if (!doc) return null;
          if (filter.status && doc.status !== filter.status) return null;
          if (
            filter.ocoPartnerId &&
            doc.ocoPartnerId?.toString() !== filter.ocoPartnerId.toString()
          ) {
            return null;
          }
          return doc;
        }),
      }));
    });

    // An open SELL leg registered in orderDocs (defaults: stop_loss @80
    // holding the 1 BTC lock — the OCO primary)
    const makeOpenSellOrder = (overrides: any = {}): any => {
      const doc = makeDoc({
        userId: new Types.ObjectId(userId),
        accountId: accountDoc._id,
        symbol: 'BTC/USDT',
        side: PaperOrderSide.SELL,
        type: PaperOrderType.STOP_LOSS,
        status: PaperOrderStatus.OPEN,
        amount: 1,
        stopPrice: 80,
        requestedPrice: 100,
        lockedAmount: 1,
        lockedAsset: 'BTC',
        ...overrides,
      });
      orderDocs.set(doc._id.toString(), doc);
      return doc;
    };

    // A fully linked pair: stop_loss primary (holds the lock) + unlocked
    // take_profit secondary
    const makeOcoPair = () => {
      const primary = makeOpenSellOrder();
      const secondary = makeOpenSellOrder({
        type: PaperOrderType.TAKE_PROFIT,
        stopPrice: 120,
        lockedAmount: undefined,
        lockedAsset: undefined,
        ocoPartnerId: primary._id,
      });
      primary.ocoPartnerId = secondary._id;
      return { primary, secondary };
    };

    // DTO for the secondary leg (take_profit sell, same amount)
    const ocoDto = (partner: any, overrides: any = {}): any =>
      baseOrderDto({
        side: PaperOrderSide.SELL,
        type: PaperOrderType.TAKE_PROFIT,
        amount: 1,
        stopPrice: 120,
        ocoPartnerId: partner._id.toString(),
        ...overrides,
      });

    describe('creating the secondary leg', () => {
      it('locks no funds, stays OPEN and back-links the primary', async () => {
        const primary = makeOpenSellOrder();

        const order = await service.createOrder(userId, ocoDto(primary));

        expect(order.status).toBe(PaperOrderStatus.OPEN);
        expect(order.ocoPartnerId).toBe(primary._id.toString());
        // The secondary shares the primary's lock: balances untouched
        expect(accountDoc.balances.BTC.free).toBeCloseTo(0, 12);
        expect(accountDoc.balances.BTC.locked).toBeCloseTo(1, 12);
        expect(accountModel.findOneAndUpdate).not.toHaveBeenCalled();
        // Primary back-linked bilaterally (atomic $set on the DB doc)
        expect(
          orderDocs.get(primary._id.toString()).ocoPartnerId.toString(),
        ).toBe(order.id);
        // Secondary persisted without lock fields
        const secondaryDoc = orderModel.mock.results[0].value;
        expect(secondaryDoc.save).toHaveBeenCalled();
        expect(secondaryDoc.lockedAmount).toBeUndefined();
        expect(secondaryDoc.lockedAsset).toBeUndefined();
      });
    });

    describe('validation rejections', () => {
      it('rejects when the partner is not open', async () => {
        const primary = makeOpenSellOrder({
          status: PaperOrderStatus.FILLED,
        });

        await expect(
          service.createOrder(userId, ocoDto(primary)),
        ).rejects.toThrow(/must be an open order/i);
      });

      it('rejects when the partner symbol does not match', async () => {
        const primary = makeOpenSellOrder({ symbol: 'ETH/USDT' });

        await expect(
          service.createOrder(userId, ocoDto(primary)),
        ).rejects.toThrow(/does not match/i);
      });

      it('rejects buy legs (OCO is sell-only)', async () => {
        const primary = makeOpenSellOrder();

        await expect(
          service.createOrder(
            userId,
            ocoDto(primary, { side: PaperOrderSide.BUY }),
          ),
        ).rejects.toThrow(/sell brackets/i);
      });

      it('rejects when the amounts differ (legs share one lock)', async () => {
        const primary = makeOpenSellOrder();

        await expect(
          service.createOrder(userId, ocoDto(primary, { amount: 0.5 })),
        ).rejects.toThrow(/same amount/i);
      });

      it('rejects a partner already linked to another OCO order', async () => {
        const primary = makeOpenSellOrder({
          ocoPartnerId: new Types.ObjectId(),
        });

        await expect(
          service.createOrder(userId, ocoDto(primary)),
        ).rejects.toThrow(/already linked/i);
      });

      it('rejects market-type OCO legs', async () => {
        const primary = makeOpenSellOrder();

        await expect(
          service.createOrder(
            userId,
            ocoDto(primary, {
              type: PaperOrderType.MARKET,
              stopPrice: undefined,
            }),
          ),
        ).rejects.toThrow(/market orders/i);
      });

      it('rejects an OCO leg that would trigger immediately, without back-linking', async () => {
        const primary = makeOpenSellOrder();

        // take_profit sell @90 with price at 100 -> already triggered
        await expect(
          service.createOrder(userId, ocoDto(primary, { stopPrice: 90 })),
        ).rejects.toThrow(/would trigger immediately/i);

        expect(
          orderDocs.get(primary._id.toString()).ocoPartnerId,
        ).toBeUndefined();
        expect(accountDoc.balances.BTC.free).toBeCloseTo(0, 12);
        expect(accountDoc.balances.BTC.locked).toBeCloseTo(1, 12);
      });
    });

    describe('back-link race', () => {
      it('rejects and does not persist the secondary when the partner went non-open after validation', async () => {
        const primary = makeOpenSellOrder();
        // DB state diverged: the doc behind the atomic back-link is
        // already canceled, but validation still sees the stale OPEN
        // snapshot via findOne
        orderDocs.set(primary._id.toString(), {
          ...primary,
          status: PaperOrderStatus.CANCELED,
        });
        orderModel.findOne.mockReturnValue({
          exec: jest.fn().mockResolvedValue(primary),
        });

        await expect(
          service.createOrder(userId, ocoDto(primary)),
        ).rejects.toThrow(/no longer open/i);

        const secondaryDoc = orderModel.mock.results[0].value;
        expect(secondaryDoc.save).not.toHaveBeenCalled();
        expect(accountDoc.balances.BTC.locked).toBeCloseTo(1, 12);
      });

      it('rejects when the partner got linked to another order concurrently', async () => {
        const primary = makeOpenSellOrder();
        // Still OPEN in the DB, but linked by a concurrent request
        orderDocs.set(primary._id.toString(), {
          ...primary,
          ocoPartnerId: new Types.ObjectId(),
        });
        orderModel.findOne.mockReturnValue({
          exec: jest.fn().mockResolvedValue(primary),
        });

        await expect(
          service.createOrder(userId, ocoDto(primary)),
        ).rejects.toThrow(/no longer open/i);

        const secondaryDoc = orderModel.mock.results[0].value;
        expect(secondaryDoc.save).not.toHaveBeenCalled();
      });

      it('cancels the just-saved secondary and rejects when the primary terminated between the back-link and the save', async () => {
        const primary = makeOpenSellOrder();
        // During the secondary's save(), the fill engine claims the
        // back-linked primary open -> filled; its cascade no-ops because
        // the secondary is not in the DB yet. The save then persists the
        // secondary as OPEN — the post-save re-check must catch this.
        orderModel.mockImplementationOnce((data: any) => {
          const doc = makeDoc(data);
          doc.save = jest.fn().mockImplementation(async () => {
            orderDocs.get(primary._id.toString()).status =
              PaperOrderStatus.FILLED;
            orderDocs.set(doc._id.toString(), doc);
            return doc;
          });
          return doc;
        });

        await expect(
          service.createOrder(userId, ocoDto(primary)),
        ).rejects.toThrow(/no longer open/i);

        // The orphaned secondary was claimed open -> canceled atomically
        const secondaryDoc = orderModel.mock.results[0].value;
        expect(secondaryDoc.save).toHaveBeenCalled();
        expect(orderDocs.get(secondaryDoc._id.toString()).status).toBe(
          PaperOrderStatus.CANCELED,
        );
        // The secondary holds no lock: no balance mutation from the
        // compensation
        expect(accountModel.findOneAndUpdate).not.toHaveBeenCalled();
      });
    });

    describe('fill cascade (processOpenOrder)', () => {
      it('fill of the primary cancels the take-profit partner without double-releasing the lock', async () => {
        const { primary, secondary } = makeOcoPair();

        const filled = await service.processOpenOrder(primary, accountDoc, 79);

        const fillPrice = 79 * 0.9995; // stop_loss sell, taker slippage
        const fee = 0.001 * fillPrice;
        expect(filled).toBe(true);
        expect(primary.status).toBe(PaperOrderStatus.FILLED);
        expect(orderDocs.get(secondary._id.toString()).status).toBe(
          PaperOrderStatus.CANCELED,
        );
        // The primary's lock was consumed by the fill, nothing released
        // twice: BTC fully gone, proceeds credited once
        expect(accountDoc.balances.BTC.locked).toBeCloseTo(0, 12);
        expect(accountDoc.balances.BTC.free).toBeCloseTo(0, 12);
        expect(accountDoc.balances.USDT.free).toBeCloseTo(
          10000 + fillPrice - fee,
          8,
        );
        // Exactly one balance update (the fill itself); the partner
        // cancel released nothing (the secondary holds no lock)
        expect(accountModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
      });

      it('fill of the secondary cancels the primary first, releasing the lock so the fill succeeds', async () => {
        const { primary, secondary } = makeOcoPair();

        const filled = await service.processOpenOrder(
          secondary,
          accountDoc,
          125,
        );

        const fillPrice = 125 * 0.9995; // take_profit sell, taker slippage
        const fee = 0.001 * fillPrice;
        expect(filled).toBe(true);
        expect(secondary.status).toBe(PaperOrderStatus.FILLED);
        const canceledPrimary = orderDocs.get(primary._id.toString());
        expect(canceledPrimary.status).toBe(PaperOrderStatus.CANCELED);
        expect(canceledPrimary.lockedAmount).toBeUndefined();
        expect(canceledPrimary.lockedAsset).toBeUndefined();
        // Lock released back to free by the cascade, then sold by the fill
        expect(accountDoc.balances.BTC.free).toBeCloseTo(0, 12);
        expect(accountDoc.balances.BTC.locked).toBeCloseTo(0, 12);
        expect(accountDoc.balances.USDT.free).toBeCloseTo(
          10000 + fillPrice - fee,
          8,
        );
        // Two balance updates: the cascade release + the fill
        expect(accountModel.findOneAndUpdate).toHaveBeenCalledTimes(2);
      });
    });

    describe('manual cancel cascade (cancelOrder)', () => {
      it('canceling the primary cancels the secondary and releases the lock exactly once', async () => {
        const { primary, secondary } = makeOcoPair();

        const canceled = await service.cancelOrder(
          userId,
          primary._id.toString(),
        );

        expect(canceled.status).toBe(PaperOrderStatus.CANCELED);
        expect(orderDocs.get(secondary._id.toString()).status).toBe(
          PaperOrderStatus.CANCELED,
        );
        expect(accountDoc.balances.BTC.free).toBeCloseTo(1, 12);
        expect(accountDoc.balances.BTC.locked).toBeCloseTo(0, 12);
        expect(accountDoc.balances.USDT.free).toBeCloseTo(10000, 8);
        // One release only (the primary's); the secondary holds no lock
        expect(accountModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
      });

      it('canceling the unlocked secondary cancels the primary and releases its lock exactly once', async () => {
        const { primary, secondary } = makeOcoPair();

        const canceled = await service.cancelOrder(
          userId,
          secondary._id.toString(),
        );

        expect(canceled.status).toBe(PaperOrderStatus.CANCELED);
        expect(orderDocs.get(primary._id.toString()).status).toBe(
          PaperOrderStatus.CANCELED,
        );
        expect(accountDoc.balances.BTC.free).toBeCloseTo(1, 12);
        expect(accountDoc.balances.BTC.locked).toBeCloseTo(0, 12);
        // One release only (the primary's, via the cascade)
        expect(accountModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('equity / drawdown helpers', () => {
    it('computes equity as USDT (free+locked) + assets valued at current prices', () => {
      const account = {
        balances: {
          USDT: { free: 1000, locked: 500 },
          BTC: { free: 0.1, locked: 0.1 },
        },
      } as any;
      expect(service.computeEquity(account, { BTC: 50000 })).toBeCloseTo(
        1500 + 0.2 * 50000,
        8,
      );
    });

    it('computes max drawdown over an equity series', () => {
      // peak 12000 -> trough 9000 = 25%
      const equities = [10000, 12000, 11000, 9000, 11500];
      expect(service.computeMaxDrawdownPct(equities)).toBeCloseTo(25, 8);
    });
  });
});
