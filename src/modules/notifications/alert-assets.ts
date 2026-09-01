/**
 * Qué activos generan aviso, y cómo se escribe su precio.
 *
 * Esto vivía como un Map hardcodeado dentro del servicio de alertas: cinco
 * activos elegidos a mano, cada uno con su formateador. Tenía dos problemas.
 * Uno, no había forma de avisar por algo que no estuviera en esa lista aunque
 * lo tuvieras en cartera. Dos, avisaba por cosas que quizá no tenías.
 */

/**
 * Lo que alertaba antes de que la selección fuera configurable. Se usa cuando
 * el usuario nunca eligió: cambiarle el comportamiento por haber agregado la
 * función sería peor que dejarlo como estaba.
 */
export const DEFAULT_ALERT_ASSETS: readonly string[] = [
  'BTC',
  'ETH',
  'NEXO',
  'MON',
  'SOL',
];

/**
 * Los activos que este usuario quiere que le avisen. `undefined` es "nunca
 * eligió" y cae en el default; `[]` es una elección explícita de no recibir
 * nada, y hay que respetarla.
 */
export function alertAssetsFor(settings?: {
  alertAssets?: string[];
}): readonly string[] {
  return settings?.alertAssets ?? DEFAULT_ALERT_ASSETS;
}

/** ¿Este usuario quiere que le avisen de este activo? */
export function wantsAsset(
  settings: { alertAssets?: string[] } | undefined,
  asset: string,
): boolean {
  return alertAssetsFor(settings).includes(asset.toUpperCase());
}

/**
 * Decimales según la magnitud del precio, en vez de una tabla por activo.
 *
 * Reproduce lo que hacían los formateadores escritos a mano —BTC y ETH sin
 * decimales, NEXO y SOL con dos, MON con cuatro— pero se lo banca cualquier
 * activo, que es lo que permite abrir la selección más allá de los cinco de
 * antes. Un precio de cuatro cifras no necesita centavos y uno de milésimas no
 * se puede mostrar sin ellas.
 */
export function formatAlertPrice(price: number): string {
  if (price >= 1000) {
    return `$${price.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  }
  if (price >= 0.1) return `$${price.toFixed(2)}`;
  if (price >= 0.001) return `$${price.toFixed(4)}`;
  return `$${price.toFixed(6)}`;
}
