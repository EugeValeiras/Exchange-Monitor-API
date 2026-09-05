/**
 * Un retiro de Binance y un depósito en Nexo de la misma cantidad, minutos
 * después, son la misma plata cambiando de lugar. Para la contabilidad de
 * lotes no pasó nada: el costo de esos BTC es el que ya tenían.
 *
 * Tratarlos como salida y entrada reales haría dos cosas falsas a la vez:
 * realizar una ganancia que no existió y reemplazar el costo original por el
 * precio de mercado del día del traspaso. En la cuenta real hay 11 traspasos
 * de BTC entre exchanges, por 4,59 BTC en total.
 */

export interface MovimientoDeFondos {
  id: string;
  asset: string;
  exchange: string;
  type: 'deposit' | 'withdrawal';
  amount: number;
  timestamp: Date;
}

export interface CriterioDeEmparejamiento {
  /** Cuánto puede tardar en acreditarse el depósito. */
  ventanaMs: number;
  /** Diferencia de monto tolerada, como fracción: la comisión de red. */
  tolerancia: number;
}

export const CRITERIO_POR_DEFECTO: CriterioDeEmparejamiento = {
  ventanaMs: 12 * 60 * 60 * 1000,
  tolerancia: 0.002,
};

/** Las dos puntas de un traspaso: de dónde salió y dónde entró. */
export interface ParDeTraspaso {
  retiro: string;
  deposito: string;
}

/**
 * Empareja cada retiro con el primer depósito libre del mismo activo, en OTRO
 * exchange, dentro de la ventana y con casi el mismo monto. Devuelve los pares.
 */
export function emparejarConDetalle(
  movimientos: MovimientoDeFondos[],
  criterio: CriterioDeEmparejamiento = CRITERIO_POR_DEFECTO,
): ParDeTraspaso[] {
  const pares: ParDeTraspaso[] = [];
  const usados = new Set<string>();
  const depositos = movimientos
    .filter((m) => m.type === 'deposit')
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  for (const retiro of movimientos.filter((m) => m.type === 'withdrawal')) {
    const par = depositos.find(
      (d) =>
        !usados.has(d.id) &&
        d.asset === retiro.asset &&
        d.exchange !== retiro.exchange &&
        Math.abs(d.timestamp.getTime() - retiro.timestamp.getTime()) <= criterio.ventanaMs &&
        Math.abs(d.amount - retiro.amount) <= retiro.amount * criterio.tolerancia,
    );
    if (par) {
      usados.add(par.id);
      pares.push({ retiro: retiro.id, deposito: par.id });
    }
  }

  return pares;
}

/**
 * Los ids de los movimientos que forman parte de un traspaso interno.
 *
 * La contabilidad de lotes sólo necesita saber CUÁLES son, para no realizar
 * una ganancia que no existió; el listado necesita además saber con quién va
 * cada uno, para juntarlos en una fila.
 */
export function emparejarTransferenciasInternas(
  movimientos: MovimientoDeFondos[],
  criterio: CriterioDeEmparejamiento = CRITERIO_POR_DEFECTO,
): Set<string> {
  const internas = new Set<string>();
  for (const par of emparejarConDetalle(movimientos, criterio)) {
    internas.add(par.retiro);
    internas.add(par.deposito);
  }
  return internas;
}
