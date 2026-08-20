import { equivalentPairs, isSamePair, splitPair } from './pair.util';

describe('pair.util', () => {
  describe('splitPair', () => {
    it('splits a unified pair', () => {
      expect(splitPair('BTC/USDT')).toEqual({ base: 'BTC', quote: 'USDT' });
    });

    it('uppercases and trims', () => {
      expect(splitPair(' btc/usdt ')).toEqual({ base: 'BTC', quote: 'USDT' });
    });

    it('returns null when there is no quote', () => {
      expect(splitPair('BTC')).toBeNull();
    });
  });

  describe('equivalentPairs', () => {
    it('expands USD-family quotes', () => {
      const pairs = equivalentPairs('BTC/USDT');
      expect(pairs).toContain('BTC/USDT');
      expect(pairs).toContain('BTC/USD');
      expect(pairs).toContain('BTC/USDC');
    });

    it('expands the same way regardless of which USD quote is asked for', () => {
      expect(equivalentPairs('BTC/USD').sort()).toEqual(
        equivalentPairs('BTC/USDT').sort(),
      );
    });

    it('does not expand crypto quotes', () => {
      expect(equivalentPairs('ETH/BTC')).toEqual(['ETH/BTC']);
    });

    it('returns the input when it is not a pair', () => {
      expect(equivalentPairs('BTC')).toEqual(['BTC']);
    });
  });

  describe('isSamePair', () => {
    it('matches across USD quotes', () => {
      expect(isSamePair('BTC/USDT', 'BTC/USD')).toBe(true);
    });

    it('does not match different assets', () => {
      expect(isSamePair('BTC/USDT', 'ETH/USDT')).toBe(false);
    });

    it('does not match a crypto quote against a USD one', () => {
      expect(isSamePair('ETH/BTC', 'ETH/USDT')).toBe(false);
    });
  });
});
