/**
 * Quotes that represent the same unit of account across exchanges.
 * Binance settles BTC in USDT while Kraken settles it in USD: for the user
 * both are "the same pair", so a filter for one has to match all of them.
 */
const USD_QUOTES = ['USDT', 'USD', 'USDC', 'BUSD', 'USDT.F', 'ZUSD'];

/**
 * Splits a unified ccxt pair ("BTC/USDT") into base and quote.
 * Returns null when the value is not a pair.
 */
export function splitPair(
  pair: string,
): { base: string; quote: string } | null {
  const [base, quote] = pair.trim().toUpperCase().split('/');
  if (!base || !quote) {
    return null;
  }
  return { base, quote };
}

/**
 * Every stored `pair` value that should be shown together with the given one.
 * `BTC/USDT` -> `['BTC/USDT', 'BTC/USD', 'BTC/USDC', ...]`
 * `ETH/BTC`  -> `['ETH/BTC']` (non-USD quotes are not interchangeable)
 */
export function equivalentPairs(pair: string): string[] {
  const parts = splitPair(pair);
  if (!parts) {
    return [pair];
  }

  const { base, quote } = parts;
  if (!USD_QUOTES.includes(quote)) {
    return [`${base}/${quote}`];
  }

  return USD_QUOTES.map((q) => `${base}/${q}`);
}

/**
 * True when both pairs refer to the same asset priced in an equivalent quote.
 */
export function isSamePair(a: string, b: string): boolean {
  return equivalentPairs(a).includes(b.trim().toUpperCase());
}
