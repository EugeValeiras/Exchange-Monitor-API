import {
  DEFAULT_ALERT_ASSETS,
  alertAssetsFor,
  formatAlertPrice,
  wantsAsset,
} from './alert-assets';

describe('alert-assets · qué se avisa y cómo se escribe', () => {
  describe('selección', () => {
    it('quien nunca eligió sigue recibiendo lo de siempre', () => {
      expect(alertAssetsFor(undefined)).toEqual(DEFAULT_ALERT_ASSETS);
      expect(alertAssetsFor({})).toEqual(DEFAULT_ALERT_ASSETS);
    });

    it('distingue "no elegí" de "no quiero nada"', () => {
      // Un array vacío es una elección, no una ausencia: si cayera en el
      // default, destildar todo volvería a encender las alertas.
      expect(alertAssetsFor({ alertAssets: [] })).toEqual([]);
      expect(wantsAsset({ alertAssets: [] }, 'BTC')).toBe(false);
    });

    it('respeta la lista elegida', () => {
      const settings = { alertAssets: ['BTC', 'XRP'] };

      expect(wantsAsset(settings, 'XRP')).toBe(true);
      expect(wantsAsset(settings, 'ETH')).toBe(false);
    });

    it('no se pierde por mayúsculas', () => {
      expect(wantsAsset({ alertAssets: ['BTC'] }, 'btc')).toBe(true);
    });
  });

  describe('formato de precio', () => {
    // Reproduce lo que hacían los formateadores por activo, que era la razón
    // por la que sólo cinco activos podían alertar.
    it('un precio de miles no necesita centavos', () => {
      expect(formatAlertPrice(64231.77)).toBe('$64,232');
      expect(formatAlertPrice(3120.5)).toBe('$3,121');
    });

    it('un precio corriente lleva dos decimales', () => {
      expect(formatAlertPrice(150.42)).toBe('$150.42');
      expect(formatAlertPrice(0.83)).toBe('$0.83');
    });

    it('un precio chico necesita más decimales para decir algo', () => {
      expect(formatAlertPrice(0.0234)).toBe('$0.0234');
      expect(formatAlertPrice(0.0000106)).toBe('$0.000011');
    });
  });
});
