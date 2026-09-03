import { BinanceDepthStreamService, DepthUpdate } from './binance-depth-stream.service';

/**
 * El stream de profundidad se conecta a demanda y se va cuando no queda nadie
 * mirando. Acá el WebSocket es de mentira: lo que se prueba es la contabilidad
 * de espectadores, qué se le pide a Binance y cómo se lee lo que manda.
 */
describe('BinanceDepthStreamService · profundidad a demanda', () => {
  let service: BinanceDepthStreamService;
  let enviados: any[];
  let ws: any;

  beforeEach(() => {
    enviados = [];
    service = new BinanceDepthStreamService({ get: () => undefined } as any);
    // Un socket abierto que registra lo que se le manda y deja inyectar mensajes.
    ws = {
      readyState: 1,
      handlers: {} as Record<string, (d: any) => void>,
      send: (m: string) => enviados.push(JSON.parse(m)),
      on(ev: string, cb: any) { this.handlers[ev] = cb; },
      ping() {}, close() {}, removeAllListeners() {},
    };
    (service as any).ws = ws;
  });

  it('el primer espectador suscribe; el segundo no repite el pedido', () => {
    service.subscribe('BTC/USDT');
    service.subscribe('BTC/USDT');
    return new Promise((r) => setImmediate(r)).then(() => {
      const subs = enviados.filter((m) => m.method === 'SUBSCRIBE');
      expect(subs).toHaveLength(1);
      expect(subs[0].params).toEqual(['btcusdt@depth20@100ms']);
    });
  });

  it('se desuscribe recién cuando se va el último', async () => {
    service.subscribe('BTC/USDT');
    service.subscribe('BTC/USDT');
    service.subscribe('ETH/USDT'); // para que quede alguien y no cierre el socket
    await new Promise((r) => setImmediate(r));
    service.unsubscribe('BTC/USDT');
    expect(enviados.filter((m) => m.method === 'UNSUBSCRIBE')).toHaveLength(0);
    service.unsubscribe('BTC/USDT');
    expect(enviados.filter((m) => m.method === 'UNSUBSCRIBE')).toEqual([
      expect.objectContaining({ params: ['btcusdt@depth20@100ms'] }),
    ]);
  });

  it('lee el libro envuelto y lo devuelve con números y símbolo', async () => {
    const recibidos: DepthUpdate[] = [];
    service.onUpdate((b) => recibidos.push(b));
    service.subscribe('BTC/USDT');
    await new Promise((r) => setImmediate(r));

    (service as any).handleMessage(
      JSON.stringify({
        stream: 'btcusdt@depth20@100ms',
        data: { lastUpdateId: 1, bids: [['80662.27', '1.60385']], asks: [['80662.28', '2.38971']] },
      }),
    );

    expect(recibidos).toHaveLength(1);
    expect(recibidos[0]).toMatchObject({
      exchange: 'binance',
      symbol: 'BTC/USDT',
      bids: [[80662.27, 1.60385]],
      asks: [[80662.28, 2.38971]],
    });
  });

  it('ignora las respuestas a SUBSCRIBE y los streams que nadie pidió', () => {
    const recibidos: DepthUpdate[] = [];
    service.onUpdate((b) => recibidos.push(b));
    (service as any).handleMessage(JSON.stringify({ result: null, id: 1 }));
    (service as any).handleMessage(JSON.stringify({ stream: 'ethusdt@depth20@100ms', data: { bids: [], asks: [] } }));
    expect(recibidos).toHaveLength(0);
  });
});
