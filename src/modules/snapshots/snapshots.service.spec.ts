import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { SnapshotsService } from './snapshots.service';
import { DailySnapshot } from './schemas/daily-snapshot.schema';
import { HourlySnapshot } from './schemas/hourly-snapshot.schema';
import { BalancesService } from '../balances/balances.service';
import { PricesService } from '../prices/prices.service';
import { TransactionsService } from '../transactions/transactions.service';

const USER_ID = '507f1f77bcf86cd799439011';

/**
 * Cuándo un snapshot horario queda marcado como parcial.
 *
 * El caso real: el 28/08/2026 Binance no contestó y el snapshot guardó 0,5 BTC
 * en vez de 1,08 — 61k contra 106k reales. El gráfico mostró un desplome que
 * nunca pasó.
 *
 * No alcanza con "falló algún exchange": nexo-pro puede estar devolviendo 530
 * de forma crónica sin aportar saldo, y descartar todos los snapshots por eso
 * dejaría la serie vacía. Hacen falta las dos cosas: un fallo Y que se note.
 */
describe('SnapshotsService · snapshots parciales', () => {
  let service: SnapshotsService;
  let saved: Record<string, unknown>;
  let lastGoodTotal: number | null;
  let failedExchanges: string[];
  let currentTotal: number;

  beforeEach(async () => {
    saved = {};
    lastGoodTotal = 106_000;
    failedExchanges = [];
    currentTotal = 106_000;

    // El modelo se comporta como constructor (para guardar) y como query
    // builder (para buscar la última lectura buena).
    const hourlyModel: any = function (doc: Record<string, unknown>) {
      saved = doc;
      return { save: async () => doc };
    };
    hourlyModel.findOne = () => ({
      sort: () => ({
        select: () => ({
          lean: async () =>
            lastGoodTotal === null ? null : { totalValueUsd: lastGoodTotal },
        }),
      }),
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SnapshotsService,
        { provide: getModelToken(DailySnapshot.name), useValue: {} },
        { provide: getModelToken(HourlySnapshot.name), useValue: hourlyModel },
        {
          provide: BalancesService,
          useValue: {
            getConsolidatedBalances: async () => ({
              byAsset: [{ asset: 'BTC', total: 1 }],
              byExchange: [],
              totalValueUsd: currentTotal,
              lastUpdated: new Date(),
              failedExchanges,
            }),
          },
        },
        {
          provide: PricesService,
          useValue: { getPricesMap: async () => ({ BTC: currentTotal }) },
        },
        { provide: TransactionsService, useValue: {} },
      ],
    }).compile();

    service = module.get<SnapshotsService>(SnapshotsService);
  });

  it('no marca nada cuando todos los exchanges contestaron', async () => {
    failedExchanges = [];
    currentTotal = 106_000;

    await service.generateHourlySnapshot(USER_ID);

    expect(saved.isPartial).toBe(false);
    expect(saved.missingExchanges).toBeUndefined();
  });

  it('marca parcial cuando un exchange falla y el total se desploma', async () => {
    failedExchanges = ['binance'];
    currentTotal = 61_000; // el caso del 28/08

    await service.generateHourlySnapshot(USER_ID);

    expect(saved.isPartial).toBe(true);
    expect(saved.missingExchanges).toEqual(['binance']);
  });

  it('NO marca parcial si el exchange caído no aportaba saldo', async () => {
    // nexo-pro devolviendo 530 sin tener fondos: el total no se mueve, así que
    // la lectura sigue siendo buena y la serie no se corta.
    failedExchanges = ['nexo-pro'];
    currentTotal = 105_900;

    await service.generateHourlySnapshot(USER_ID);

    expect(saved.isPartial).toBe(false);
    expect(saved.missingExchanges).toEqual(['nexo-pro']);
  });

  it('NO marca parcial ante una caída real de mercado sin fallos', async () => {
    failedExchanges = [];
    currentTotal = 61_000;

    await service.generateHourlySnapshot(USER_ID);

    expect(saved.isPartial).toBe(false);
  });

  it('asume buena la primera lectura, sin nada con qué comparar', async () => {
    lastGoodTotal = null;
    failedExchanges = ['binance'];
    currentTotal = 61_000;

    await service.generateHourlySnapshot(USER_ID);

    expect(saved.isPartial).toBe(false);
  });
});
