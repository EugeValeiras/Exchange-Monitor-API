/**
 * Qué avisa, y cómo se escribe un precio.
 *
 * Esto empezó como un Map de cinco activos escrito a mano, pasó a una
 * selección de activos, y ahora la unidad es el PAR. El motivo es concreto:
 * un activo puede cotizar contra varias monedas y no son la misma cosa —NEXO
 * vale 0,83 USDT y 0,0000106 BTC—, así que "avisame de NEXO" no alcanza para
 * decir qué querés mirar.
 */

/**
 * Monedas de cotización que se muestran con "$". Las demás se escriben con su
 * ticker al lado, porque un precio en BTC mostrado como "$0.00" no dice nada.
 */
const DOLLAR_QUOTES = new Set([
  'USD',
  'USDT',
  'USDC',
  'BUSD',
  'DAI',
  'TUSD',
  'USDP',
]);

/**
 * Los activos que alertaban antes de que hubiera selección. Se usan sólo para
 * traducir la preferencia vieja de quien nunca eligió pares.
 */
export const DEFAULT_ALERT_ASSETS: readonly string[] = [
  'BTC',
  'ETH',
  'NEXO',
  'MON',
  'SOL',
];

export interface AlertSettings {
  alertPairs?: string[];
  alertAssets?: string[];
}

export function isDollarQuote(quote: string): boolean {
  return DOLLAR_QUOTES.has(quote.toUpperCase());
}

/** `NEXO/BTC` → `{ base: 'NEXO', quote: 'BTC' }`. */
export function splitSymbol(symbol: string): { base: string; quote: string } {
  const [rawBase, rawQuote] = symbol.split('/');
  return {
    base: (rawBase ?? '').toUpperCase(),
    quote: (rawQuote ?? '').toUpperCase(),
  };
}

/**
 * ¿Este usuario quiere que le avisen de este par?
 *
 * Con `alertPairs` la respuesta es literal: el par está elegido o no, sin
 * importar contra qué cotice. Es lo que permite seguir NEXO/BTC.
 *
 * Sin `alertPairs` se traduce la preferencia vieja: el activo tenía que estar
 * entre los elegidos Y cotizar en dólares. Esa segunda condición era el
 * arreglo del spam de NEXO/BTC, y sigue valiendo para quien no eligió pares:
 * nadie pidió empezar a recibir avisos que antes no llegaban.
 */
export function wantsSymbol(
  settings: AlertSettings | undefined,
  symbol: string,
): boolean {
  const { base, quote } = splitSymbol(symbol);

  if (settings?.alertPairs) {
    return settings.alertPairs.some((p) => p.toUpperCase() === symbol.toUpperCase());
  }

  const assets = settings?.alertAssets ?? DEFAULT_ALERT_ASSETS;
  return assets.includes(base) && isDollarQuote(quote);
}

/** Los pares que le interesan a este usuario, ya resueltos. */
export function alertPairsFor(
  settings: AlertSettings | undefined,
  pares: readonly string[],
): string[] {
  if (settings?.alertPairs) {
    return [...settings.alertPairs];
  }
  return pares.filter((p) => wantsSymbol(settings, p));
}

/**
 * El precio, escrito en la moneda en la que cotiza.
 *
 * Los decimales salen de la magnitud y no de una tabla por activo: un precio
 * de miles no necesita centavos y uno de millonésimas —que es lo que pasa
 * apenas la cotización es contra BTC— no se puede escribir sin ocho.
 */
export function formatAlertPrice(price: number, quote = 'USD'): string {
  const q = quote.toUpperCase();
  const decimales =
    price >= 1000 ? 0 : price >= 0.1 ? 2 : price >= 0.001 ? 4 : 8;

  const numero =
    decimales === 0
      ? price.toLocaleString('en-US', { maximumFractionDigits: 0 })
      : price.toFixed(decimales);

  return isDollarQuote(q) ? `$${numero}` : `${numero} ${q}`;
}
