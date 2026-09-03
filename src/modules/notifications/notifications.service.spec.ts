import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotificationsService } from './notifications.service';
import { UsersService } from '../users/users.service';
import { FirebaseService } from './firebase.service';

describe('NotificationsService · a quién le llega cada aviso', () => {
  let service: NotificationsService;
  let stored: any;
  let saved: any;

  const build = async (users: any[] = []): Promise<NotificationsService> => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        {
          provide: UsersService,
          useValue: {
            findUsersWithNotificationsEnabled: async () => users,
            findById: async () => stored,
            updateNotificationSettings: async (_id: string, settings: any) => {
              saved = settings;
              return { notificationSettings: settings };
            },
          },
        },
        { provide: FirebaseService, useValue: {} },
        { provide: EventEmitter2, useValue: { emit: () => undefined } },
      ],
    }).compile();

    return module.get<NotificationsService>(NotificationsService);
  };

  const user = (settings: any) => ({
    pushTokens: ['token-1'],
    notificationSettings: { enabled: true, priceChangeThreshold: 5, ...settings },
  });

  describe('filtrado por activo', () => {
    it('no le manda un par que no sigue', async () => {
      service = await build([user({ alertPairs: ['BTC/USDT'] })]);

      expect(await service.getTokensForPriceChange(10, 'ETH/USDT')).toEqual([]);
      expect(await service.getTokensForPriceChange(10, 'BTC/USDT')).toEqual(['token-1']);
    });

    it('separa los dos pares del mismo activo', async () => {
      service = await build([user({ alertPairs: ['NEXO/BTC'] })]);

      expect(await service.getTokensForPriceChange(10, 'NEXO/BTC')).toEqual(['token-1']);
      expect(await service.getTokensForPriceChange(10, 'NEXO/USDT')).toEqual([]);
    });

    it('quien nunca eligió sigue recibiendo los de siempre', async () => {
      service = await build([user({})]);

      expect(await service.getTokensForPriceChange(10, 'BTC/USDT')).toEqual(['token-1']);
      expect(await service.getTokensForPriceChange(10, 'DOGE/USDT')).toEqual([]);
      // Y sigue SIN recibir los que no cotizan en dólares.
      expect(await service.getTokensForPriceChange(10, 'BTC/ETH')).toEqual([]);
    });

    it('el umbral se sigue respetando dentro del par elegido', async () => {
      service = await build([
        user({ alertPairs: ['BTC/USDT'], priceChangeThreshold: 10 }),
      ]);

      expect(await service.getTokensForPriceChange(4, 'BTC/USDT')).toEqual([]);
      expect(await service.getTokensForPriceChange(12, 'BTC/USDT')).toEqual(['token-1']);
    });

    it('la unión de intereses no repite ni pierde a nadie', async () => {
      service = await build([
        user({ alertPairs: ['BTC/USDT', 'XRP/USDT'] }),
        user({ alertPairs: ['XRP/USDT', 'SOL/USDT'] }),
      ]);

      expect([...(await service.getSymbolsWithInterest([]))].sort()).toEqual([
        'BTC/USDT',
        'SOL/USDT',
        'XRP/USDT',
      ]);
    });
  });

  describe('guardar ajustes', () => {
    it('un cliente que no conoce la selección no la borra', async () => {
      // La app publicada y la webapp sin actualizar mandan el objeto sin
      // alertAssets; como guardar reemplaza el objeto entero, tocar el umbral
      // desde ahí vaciaba la selección hecha en el otro cliente.
      stored = { notificationSettings: { alertPairs: ['BTC/USDT', 'XRP/USDT'] } };
      service = await build();

      await service.updateSettings('u1', {
        enabled: true,
        priceChangeThreshold: 3,
      });

      expect(saved.alertPairs).toEqual(['BTC/USDT', 'XRP/USDT']);
    });

    it('un cliente que sí la manda la pisa', async () => {
      stored = { notificationSettings: { alertPairs: ['BTC/USDT', 'XRP/USDT'] } };
      service = await build();

      await service.updateSettings('u1', {
        enabled: true,
        priceChangeThreshold: 3,
        alertPairs: ['ETH/USDT'],
      });

      expect(saved.alertPairs).toEqual(['ETH/USDT']);
    });

    it('vaciar la selección se guarda como vacío, no como "no elegí"', async () => {
      stored = { notificationSettings: { alertPairs: ['BTC/USDT'] } };
      service = await build();

      await service.updateSettings('u1', {
        enabled: true,
        priceChangeThreshold: 3,
        alertPairs: [],
      });

      expect(saved.alertPairs).toEqual([]);
    });
  });
});
