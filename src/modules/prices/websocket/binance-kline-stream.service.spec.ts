import { BinanceKlineStreamService, KlineUpdate } from './binance-kline-stream.service';

/**
 * Las velas se suscriben a demanda y se sueltan cuando no queda nadie. El
 * WebSocket es de mentira: lo que se prueba es la contabilidad de espectadores
 * y cómo se lee lo que manda Binance.
 */
describe('BinanceKlineStreamService · velas a demanda', () => {
  let service: BinanceKlineStreamService;
  let enviados: any[];

  beforeEach(() => {
    enviados = [];
    service = new BinanceKlineStreamService({ get: () => undefined } as any);
    (service as any).ws = {
      readyState: 1,
      send: (m: string) => enviados.push(JSON.parse(m)),
      on() {}, ping() {}, close() {}, removeAllListeners() {},
    };
  });

  it('sólo acepta los intervalos que ofrecen las pantallas', () => {
    expect(service.soporta('1d')).toBe(true);
    expect(service.soporta('15m')).toBe(true);
    expect(service.soporta('3d')).toBe(false);
    expect(service.soporta('')).toBe(false);
  });

  it('el primer espectador suscribe; el segundo no repite el pedido', async () => {
    service.subscribe('BTC/USDT', '1d');
    service.subscribe('BTC/USDT', '1d');
    await new Promise((r) => setImmediate(r));

    const subs = enviados.filter((m) => m.method === 'SUBSCRIBE');
    expect(subs).toHaveLength(1);
    expect(subs[0].params).toEqual(['btcusdt@kline_1d']);
  });

  it('el mismo par en otro intervalo es otra suscripción', async () => {
    service.subscribe('BTC/USDT', '1d');
    service.subscribe('BTC/USDT', '1h');
    await new Promise((r) => setImmediate(r));

    const params = enviados.filter((m) => m.method === 'SUBSCRIBE').flatMap((m) => m.params);
    expect(params).toEqual(['btcusdt@kline_1d', 'btcusdt@kline_1h']);
  });

  it('un intervalo que no soporta no llega a pedirse', async () => {
    service.subscribe('BTC/USDT', '3d');
    await new Promise((r) => setImmediate(r));
    expect(enviados).toHaveLength(0);
  });

  it('se desuscribe recién cuando se va el último', async () => {
    service.subscribe('BTC/USDT', '1d');
    service.subscribe('BTC/USDT', '1d');
    service.subscribe('ETH/USDT', '1d'); // para que el socket no cierre
    await new Promise((r) => setImmediate(r));

    service.unsubscribe('BTC/USDT', '1d');
    expect(enviados.filter((m) => m.method === 'UNSUBSCRIBE')).toHaveLength(0);

    service.unsubscribe('BTC/USDT', '1d');
    expect(enviados.filter((m) => m.method === 'UNSUBSCRIBE')[0].params).toEqual([
      'btcusdt@kline_1d',
    ]);
  });

  it('lee la vela y dice si el período ya cerró', async () => {
    const recibidas: KlineUpdate[] = [];
    service.onUpdate((k) => recibidas.push(k));
    service.subscribe('BTC/USDT', '1d');
    await new Promise((r) => setImmediate(r));

    (service as any).handleMessage(
      JSON.stringify({
        stream: 'btcusdt@kline_1d',
        data: {
          k: { t: 1780000000000, o: '80000.1', h: '81500', l: '79000', c: '81000.5', v: '123.4', x: false },
        },
      }),
    );

    expect(recibidas).toHaveLength(1);
    expect(recibidas[0]).toMatchObject({
      exchange: 'binance',
      symbol: 'BTC/USDT',
      timeframe: '1d',
      timestamp: 1780000000000,
      open: 80000.1,
      close: 81000.5,
      closed: false,
    });
  });

  it('ignora respuestas de control y streams que nadie pidió', () => {
    const recibidas: KlineUpdate[] = [];
    service.onUpdate((k) => recibidas.push(k));
    (service as any).handleMessage(JSON.stringify({ result: null, id: 1 }));
    (service as any).handleMessage(
      JSON.stringify({ stream: 'ethusdt@kline_1d', data: { k: { t: 1, o: '1', h: '1', l: '1', c: '1', v: '1' } } }),
    );
    expect(recibidas).toHaveLength(0);
  });
});
