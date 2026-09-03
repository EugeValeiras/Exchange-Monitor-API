import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import { PnlService } from './pnl.service';
import { CostBasisLot } from './schemas/cost-basis-lot.schema';
import { RealizedPnl } from './schemas/realized-pnl.schema';
import { CachedBalance } from '../balances/schemas/cached-balance.schema';
import { PricesService } from '../prices/prices.service';
import { PriceHistoryService } from '../prices/price-history.service';
import { TransactionsService } from '../transactions/transactions.service';
import { TransactionType } from '../../common/constants/transaction-types.constant';

const USER = new Types.ObjectId();

/**
 * Qué le hace cada transacción a los lotes.
 *
 * Los casos salen de la cuenta real del 03/09/2026, cuando los lotes decían
 * 36.373 USDC contra 4,22 reales y 11.250 NEXO contra 25.457: los dólares
 * estables se creaban al comprarlos y nadie los consumía al gastarlos, y los
 * 5.104 NEXO que entraron por interés no existían para la contabilidad.
 */
describe('PnlService · qué le hace cada transacción a los lotes', () => {
  let service: PnlService;
  let lotesCreados: any[];
  let lotesAbiertos: any[];
  let realizados: any[];

  const tx = (campos: Partial<any>) => ({
    _id: new Types.ObjectId(),
    userId: USER,
    exchange: 'binance',
    timestamp: new Date('2026-01-20T12:00:00Z'),
    amount: 1,
    ...campos,
  });

  beforeEach(async () => {
    lotesCreados = [];
    lotesAbiertos = [];
    realizados = [];

    const lotModel: any = function (doc: any) {
      lotesCreados.push(doc);
      return { ...doc, save: async () => doc };
    };
    lotModel.find = () => ({ sort: async () => lotesAbiertos });

    const realizedModel: any = function (doc: any) {
      realizados.push(doc);
      return { save: async () => doc };
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PnlService,
        { provide: getModelToken(CostBasisLot.name), useValue: lotModel },
        { provide: getModelToken(RealizedPnl.name), useValue: realizedModel },
        { provide: getModelToken(CachedBalance.name), useValue: {} },
        { provide: PricesService, useValue: { getHistoricalPricesMap: async () => ({}) } },
        {
          provide: PriceHistoryService,
          useValue: { getHistoricalPriceForAsset: async () => 0.9 },
        },
        { provide: TransactionsService, useValue: {} },
      ],
    }).compile();

    service = module.get(PnlService);
  });

  it('el interés es ingreso: crea un lote al precio del día', async () => {
    await service.processTransaction(
      tx({ type: TransactionType.INTEREST, asset: 'NEXO', amount: 6.00785036, exchange: 'nexo-manual' }) as any,
    );

    expect(lotesCreados).toHaveLength(1);
    expect(lotesCreados[0]).toMatchObject({
      asset: 'NEXO',
      originalAmount: 6.00785036,
      costPerUnit: 0.9,
      source: 'interest',
    });
  });

  it('un dólar estable no lleva lotes: ni al comprarlo ni al venderlo', async () => {
    await service.processTransaction(
      tx({ type: TransactionType.TRADE, side: 'buy', asset: 'USDC', amount: 30000, price: 1.00131, priceAsset: 'USDT', pair: 'USDC/USDT' }) as any,
    );
    await service.processTransaction(
      tx({ type: TransactionType.TRADE, side: 'sell', asset: 'USDC', amount: 30000, price: 1.0002, priceAsset: 'USDT', pair: 'USDC/USDT' }) as any,
    );

    expect(lotesCreados).toHaveLength(0);
    expect(realizados).toHaveLength(0);
  });

  it('la comisión cobrada en el mismo activo no entra al lote', async () => {
    await service.processTransaction(
      tx({ type: TransactionType.TRADE, side: 'buy', asset: 'BTC', amount: 0.03685, price: 96984.26, priceAsset: 'USDT', pair: 'BTC/USDT', fee: 0.00003685, feeAsset: 'BTC' }) as any,
    );

    expect(lotesCreados[0].originalAmount).toBeCloseTo(0.03681315, 10);
    expect(lotesCreados[0].costPerUnit).toBe(96984.26);
  });

  it('la comisión en OTRO activo deja el lote entero', async () => {
    await service.processTransaction(
      tx({ type: TransactionType.TRADE, side: 'buy', asset: 'BTC', amount: 0.03685, price: 96984.26, priceAsset: 'USDT', fee: 3.5, feeAsset: 'USDT' }) as any,
    );

    expect(lotesCreados[0].originalAmount).toBe(0.03685);
  });

  describe('depósitos y retiros', () => {
    const retiro = tx({ type: TransactionType.WITHDRAWAL, asset: 'BTC', amount: 0.99764623, exchange: 'binance' });
    const deposito = tx({ type: TransactionType.DEPOSIT, asset: 'BTC', amount: 0.99764623, exchange: 'nexo-manual' });

    it('un traspaso entre tus exchanges no mueve nada', async () => {
      lotesAbiertos = [{ remainingAmount: 1, costPerUnit: 80000, acquiredAt: new Date('2025-12-01'), _id: new Types.ObjectId(), save: async () => null }];
      const internas = new Set([retiro._id.toString(), deposito._id.toString()]);

      await service.processTransaction(retiro as any, internas);
      await service.processTransaction(deposito as any, internas);

      expect(lotesCreados).toHaveLength(0);
      expect(realizados).toHaveLength(0);
      expect(lotesAbiertos[0].remainingAmount).toBe(1);
    });

    it('un retiro sin par saca los lotes AL COSTO: sin ganancia', async () => {
      const lote = { remainingAmount: 1, costPerUnit: 80000, acquiredAt: new Date('2025-12-01'), _id: new Types.ObjectId(), save: async () => null };
      lotesAbiertos = [lote];

      await service.processTransaction(retiro as any, new Set());

      expect(lote.remainingAmount).toBeCloseTo(1 - 0.99764623, 10);
      expect(realizados).toHaveLength(1);
      expect(realizados[0]).toMatchObject({ source: 'withdrawal', realizedPnl: 0 });
      expect(realizados[0].proceeds).toBeCloseTo(realizados[0].costBasis, 6);
    });

    it('un depósito sin par es una compra al precio del día', async () => {
      await service.processTransaction(deposito as any, new Set());

      expect(lotesCreados).toHaveLength(1);
      expect(lotesCreados[0]).toMatchObject({ source: 'deposit', costPerUnit: 0.9 });
    });

    it('en el alta incremental —sin la historia completa— no se tocan', async () => {
      // Sin el conjunto de traspasos no hay forma de saber si el depósito
      // viene de un retiro propio que todavía no sincronizó.
      await service.processTransaction(retiro as any);
      await service.processTransaction(deposito as any);

      expect(lotesCreados).toHaveLength(0);
      expect(realizados).toHaveLength(0);
    });
  });
});
