import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { ThresholdAlertService } from './threshold-alert.service';
import { PriceThreshold } from './schemas/price-threshold.schema';
import { FirebaseService } from './firebase.service';
import { NotificationsService } from './notifications.service';

/**
 * El bucle que llegaba al teléfono: el último precio notificado se llevaba por
 * ACTIVO, así que las cotizaciones de NEXO/USDT (0,83) y NEXO/BTC (0,0000106)
 * se pisaban entre sí. Cada update comparaba contra el precio del otro par y
 * disparaba "−100 %" y "+7.754.811 %", alternándose para siempre.
 */
describe('ThresholdAlertService · alertas de precio', () => {
  let service: ThresholdAlertService;
  let sent: Array<{ title: string; body: string }>;
  let seguidos: Set<string>;

  beforeEach(async () => {
    sent = [];
    seguidos = new Set([
      'BTC/USDT',
      'ETH/USDT',
      'NEXO/USDT',
      'MON/USDT',
      'SOL/USDT',
    ]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ThresholdAlertService,
        {
          provide: getModelToken(PriceThreshold.name),
          useValue: {
            find: () => ({ exec: async () => [] }),
            findOneAndUpdate: async () => ({}),
          },
        },
        {
          provide: FirebaseService,
          useValue: {
            isReady: () => true,
            sendMulticastNotification: async (
              _tokens: string[],
              title: string,
              body: string,
            ) => {
              sent.push({ title, body });
              return { successCount: 1, failureCount: 0 };
            },
          },
        },
        {
          provide: NotificationsService,
          useValue: {
            getSymbolsWithInterest: async () => seguidos,
            getTokensForPriceChange: async (_pct: number, symbol: string) =>
              seguidos.has(symbol.toUpperCase()) ? ['token-1'] : [],
            getEnabledUserTokens: async () => ['token-1'],
          },
        },
      ],
    }).compile();

    service = module.get<ThresholdAlertService>(ThresholdAlertService);
    await service.onModuleInit();
  });

  const update = (symbol: string, price: number) =>
    service.handlePriceUpdate({ symbol, price } as never);

  it('no mezcla dos pares del mismo activo', async () => {
    await update('NEXO/USDT', 0.83); // primera lectura: sólo inicializa
    await update('NEXO/USDT', 0.83); // sin cambio, no alerta

    expect(sent).toHaveLength(0);
  });

  it('no avisa de un par que no está elegido', async () => {
    await update('NEXO/USDT', 0.83);
    await update('NEXO/BTC', 0.0000106);
    await update('NEXO/USDT', 0.83);
    await update('NEXO/BTC', 0.0000107);

    // NEXO/BTC no está en la selección, así que no llega nada. Antes esta
    // secuencia mandaba una alerta por cada update, porque el último precio
    // se llevaba por activo y los dos pares se pisaban.
    expect(sent).toHaveLength(0);
  });

  it('un par contra BTC se puede seguir, y el precio va en BTC', async () => {
    // El motivo del cambio: antes era imposible porque el aviso salía con
    // formato de dólares y "$0.00" no dice nada.
    seguidos.add('NEXO/BTC');
    service.invalidateInterestCache();

    await update('NEXO/BTC', 0.0000106);
    await update('NEXO/BTC', 0.0000120); // +13 %

    expect(sent).toHaveLength(1);
    expect(sent[0].title).toContain('NEXO/BTC');
    expect(sent[0].body).toContain('BTC');
    expect(sent[0].body).not.toContain('$');
  });

  it('seguir un par no arrastra al otro del mismo activo', async () => {
    seguidos.add('NEXO/BTC');
    seguidos.delete('NEXO/USDT');
    service.invalidateInterestCache();

    await update('NEXO/USDT', 0.80);
    await update('NEXO/USDT', 0.95);

    expect(sent).toHaveLength(0);
  });

  it('sí alerta cuando el par en dólares se mueve de verdad', async () => {
    await update('NEXO/USDT', 0.80);
    await update('NEXO/USDT', 0.90); // +12,5 %

    expect(sent).toHaveLength(1);
    expect(sent[0].body).toContain('NEXO');
    expect(sent[0].body).toContain('12.5%');
  });

  it('descarta un precio en cero en vez de dividir por él', async () => {
    await update('NEXO/USDT', 0.83);
    await update('NEXO/USDT', 0);

    expect(sent).toHaveLength(0);
  });

  it('no alerta por un activo que no se sigue', async () => {
    await update('DOGE/USDT', 0.10);
    await update('DOGE/USDT', 0.50);

    expect(sent).toHaveLength(0);
  });

  it('sí alerta por un par que el usuario agregó a su selección', async () => {
    // Antes esto era imposible: la lista era una tabla escrita a mano en el
    // código y DOGE no estaba.
    seguidos.add('DOGE/USDT');
    service.invalidateInterestCache();

    await update('DOGE/USDT', 0.10);
    await update('DOGE/USDT', 0.50); // +400 %

    expect(sent).toHaveLength(1);
    expect(sent[0].body).toContain('DOGE');
  });

  it('deja de alertar en cuanto se destilda el par', async () => {
    await update('NEXO/USDT', 0.80);

    seguidos.delete('NEXO/USDT');
    service.invalidateInterestCache();

    await update('NEXO/USDT', 0.90); // movimiento de sobra, pero ya no interesa

    expect(sent).toHaveLength(0);
  });

  it('el cambio de selección no espera a que venza el cache', async () => {
    // Sin la invalidación por evento habría que esperar el TTL, y destildar un
    // activo parecería no hacer nada.
    await update('SOL/USDT', 100);
    seguidos.delete('SOL/USDT');
    service.invalidateInterestCache();
    await update('SOL/USDT', 150);

    expect(sent).toHaveLength(0);
  });
});
