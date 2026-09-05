import {
  emparejarConDetalle,
  emparejarTransferenciasInternas,
  MovimientoDeFondos,
} from './transferencias-internas';

const en = (min: number) => new Date(Date.UTC(2026, 0, 6, 18, 30 + min));

function mov(
  id: string,
  type: 'deposit' | 'withdrawal',
  exchange: string,
  amount: number,
  minutos: number,
  asset = 'BTC',
): MovimientoDeFondos {
  return { id, type, exchange, amount, asset, timestamp: en(minutos) };
}

describe('emparejarTransferenciasInternas · la misma plata cambiando de lugar', () => {
  it('empareja un retiro con el depósito que lo recibe en otro exchange', () => {
    const internas = emparejarTransferenciasInternas([
      mov('r1', 'withdrawal', 'binance', 0.99764623, 0),
      mov('d1', 'deposit', 'nexo-manual', 0.99764623, 36),
    ]);
    expect(internas).toEqual(new Set(['r1', 'd1']));
  });

  it('tolera la comisión de red: el caso real del 06/01/2026', () => {
    // Salieron 0,50000003 de Nexo y entraron 0,49994512 en Binance.
    const internas = emparejarTransferenciasInternas([
      mov('d', 'deposit', 'binance', 0.49994512, 0),
      mov('r', 'withdrawal', 'nexo-manual', 0.50000003, 147),
    ]);
    expect(internas.size).toBe(2);
  });

  it('NO empareja dentro del mismo exchange ni entre activos distintos', () => {
    const internas = emparejarTransferenciasInternas([
      mov('r', 'withdrawal', 'binance', 1, 0),
      mov('d-mismo', 'deposit', 'binance', 1, 10),
      mov('d-otro-activo', 'deposit', 'kraken', 1, 10, 'ETH'),
    ]);
    expect(internas.size).toBe(0);
  });

  it('NO empareja si el depósito tarda más que la ventana', () => {
    const internas = emparejarTransferenciasInternas([
      mov('r', 'withdrawal', 'binance', 1, 0),
      mov('d', 'deposit', 'kraken', 1, 13 * 60),
    ]);
    expect(internas.size).toBe(0);
  });

  it('un retiro de verdad —a una billetera afuera— queda sin par', () => {
    const internas = emparejarTransferenciasInternas([
      mov('r1', 'withdrawal', 'nexo-manual', 33250.7, 0, 'NEXO'),
    ]);
    expect(internas.size).toBe(0);
  });

  it('cada depósito se usa una sola vez', () => {
    const internas = emparejarTransferenciasInternas([
      mov('r1', 'withdrawal', 'binance', 1, 0),
      mov('r2', 'withdrawal', 'binance', 1, 5),
      mov('d1', 'deposit', 'kraken', 1, 20),
    ]);
    expect(internas).toEqual(new Set(['r1', 'd1']));
  });
});

describe('emparejarConDetalle · con quién va cada punta', () => {
  const en = (min: number) => new Date(Date.UTC(2026, 7, 24, 15, 48 + min));

  it('dice qué retiro va con qué depósito, no sólo que son internos', () => {
    // El caso de la captura: 0,579245 BTC salen de Nexo a las 15:48 y entran
    // en Binance a las 16:48.
    const pares = emparejarConDetalle([
      { id: 'retiro', type: 'withdrawal', exchange: 'nexo-manual', amount: 0.579245, asset: 'BTC', timestamp: en(0) },
      { id: 'deposito', type: 'deposit', exchange: 'binance', amount: 0.579245, asset: 'BTC', timestamp: en(60) },
    ]);

    expect(pares).toEqual([{ retiro: 'retiro', deposito: 'deposito' }]);
  });

  it('cada depósito se usa una sola vez', () => {
    const pares = emparejarConDetalle([
      { id: 'r1', type: 'withdrawal', exchange: 'binance', amount: 1, asset: 'BTC', timestamp: en(0) },
      { id: 'r2', type: 'withdrawal', exchange: 'binance', amount: 1, asset: 'BTC', timestamp: en(5) },
      { id: 'd1', type: 'deposit', exchange: 'kraken', amount: 1, asset: 'BTC', timestamp: en(20) },
    ]);

    expect(pares).toHaveLength(1);
    expect(pares[0].retiro).toBe('r1');
  });

  it('un retiro a una billetera de afuera no arma par', () => {
    const pares = emparejarConDetalle([
      { id: 'r', type: 'withdrawal', exchange: 'nexo-manual', amount: 33250.7, asset: 'NEXO', timestamp: en(0) },
    ]);
    expect(pares).toEqual([]);
  });
});
