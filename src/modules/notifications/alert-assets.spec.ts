import {
  DEFAULT_ALERT_ASSETS,
  alertPairsFor,
  formatAlertPrice,
  isDollarQuote,
  splitSymbol,
  wantsSymbol,
} from './alert-assets';

describe('alert-assets · qué se avisa y cómo se escribe', () => {
  describe('selección por par', () => {
    it('un par elegido avisa aunque no cotice en dólares', () => {
      // El motivo del cambio: NEXO/BTC era imposible de seguir porque el
      // filtro de "sólo contra dólar" existía para que no llegara con
      // formato de dólares.
      const s = { alertPairs: ['NEXO/BTC'] };

      expect(wantsSymbol(s, 'NEXO/BTC')).toBe(true);
      expect(wantsSymbol(s, 'NEXO/USDT')).toBe(false);
    });

    it('los dos pares del mismo activo se siguen por separado', () => {
      const s = { alertPairs: ['NEXO/USDT'] };

      expect(wantsSymbol(s, 'NEXO/USDT')).toBe(true);
      expect(wantsSymbol(s, 'NEXO/BTC')).toBe(false);
    });

    it('no se pierde por mayúsculas', () => {
      expect(wantsSymbol({ alertPairs: ['nexo/btc'] }, 'NEXO/BTC')).toBe(true);
    });

    it('vacío es una elección, no una ausencia', () => {
      expect(wantsSymbol({ alertPairs: [] }, 'BTC/USDT')).toBe(false);
    });
  });

  describe('quien todavía no eligió pares', () => {
    it('mantiene exactamente lo que recibía antes', () => {
      // La app publicada manda alertAssets. Nadie pidió empezar a recibir
      // avisos que antes no llegaban, así que la regla vieja sigue en pie:
      // el activo elegido Y cotizando en dólares.
      const s = { alertAssets: ['NEXO'] };

      expect(wantsSymbol(s, 'NEXO/USDT')).toBe(true);
      expect(wantsSymbol(s, 'NEXO/BTC')).toBe(false);
    });

    it('sin nada configurado, los cinco de siempre', () => {
      expect(wantsSymbol(undefined, 'BTC/USDT')).toBe(true);
      expect(wantsSymbol(undefined, 'DOGE/USDT')).toBe(false);
      expect(DEFAULT_ALERT_ASSETS).toContain('BTC');
    });

    it('traduce la preferencia vieja a los pares que existen', () => {
      const pares = ['NEXO/USDT', 'NEXO/BTC', 'BTC/USDT', 'DOGE/USDT'];

      expect(alertPairsFor({ alertAssets: ['NEXO', 'BTC'] }, pares)).toEqual([
        'NEXO/USDT',
        'BTC/USDT',
      ]);
    });

    it('la lista de pares gana sobre la de activos', () => {
      const pares = ['NEXO/USDT', 'NEXO/BTC'];

      expect(
        alertPairsFor({ alertPairs: ['NEXO/BTC'], alertAssets: ['BTC'] }, pares),
      ).toEqual(['NEXO/BTC']);
    });
  });

  describe('formato de precio', () => {
    it('en dólares lleva el signo pegado', () => {
      expect(formatAlertPrice(64231.77, 'USDT')).toBe('$64,232');
      expect(formatAlertPrice(0.83, 'USD')).toBe('$0.83');
    });

    it('contra otra moneda lleva su ticker, no "$"', () => {
      // Mostrar 0,0000106 BTC como "$0.00" era decir cualquier cosa: ése era
      // el motivo real de no poder alertar NEXO/BTC.
      expect(formatAlertPrice(0.0000106, 'BTC')).toBe('0.00001060 BTC');
      expect(formatAlertPrice(31.24, 'MON')).toBe('31.24 MON');
    });

    it('un precio de millonésimas necesita ocho decimales', () => {
      // Con seis, dos precios distintos de NEXO/BTC se escribían igual.
      expect(formatAlertPrice(0.00001227, 'BTC')).toBe('0.00001227 BTC');
      expect(formatAlertPrice(0.00001225, 'BTC')).toBe('0.00001225 BTC');
    });
  });

  describe('utilidades', () => {
    it('parte el símbolo', () => {
      expect(splitSymbol('NEXO/BTC')).toEqual({ base: 'NEXO', quote: 'BTC' });
    });

    it('sabe qué monedas son dólares', () => {
      expect(isDollarQuote('usdt')).toBe(true);
      expect(isDollarQuote('BTC')).toBe(false);
    });
  });
});
