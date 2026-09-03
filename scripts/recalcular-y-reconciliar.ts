/**
 * Recalcula la contabilidad de lotes y muestra cómo reconcilia cada activo
 * contra el saldo real, antes y después. No pasa por HTTP ni por el JWT:
 * levanta el contexto de Nest y llama al servicio.
 *
 * Pensado para correr contra una COPIA de la base:
 *
 *   MONGODB_URI=mongodb://localhost:27017/exchange-monitor-lotes \
 *   CRON_DAILY_SNAPSHOT=false CRON_HOURLY_SNAPSHOT=false CRON_SYNC_TRANSACTIONS=false \
 *   npx ts-node -r tsconfig-paths/register scripts/recalcular-y-reconciliar.ts <userId>
 *
 * Y desde la Pi, no desde afuera: los precios históricos anteriores a la
 * historia local salen de Binance, que bloquea otras regiones con 451.
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PnlService } from '../src/modules/pnl/pnl.service';

async function main() {
  const userId = process.argv[2];
  if (!userId) throw new Error('falta el userId');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['warn', 'error'] });
  const pnl = app.get(PnlService);

  const antes = await pnl.reconciliar(userId);
  const t0 = Date.now();
  const { processed } = await pnl.recalculateAll(userId);
  const despues = await pnl.reconciliar(userId);

  const fila = (a: any) =>
    `${a.asset.padEnd(7)} ${a.enLotes.toFixed(6).padStart(16)} ${a.real.toFixed(6).padStart(16)} ` +
    `${a.diferencia.toFixed(6).padStart(14)}  ${a.reconcilia ? 'ok' : a.motivo}`;

  console.log(`\nprocesadas ${processed} transacciones en ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  console.log('\nANTES   activo         en lotes             real     diferencia');
  antes.activos.forEach((a) => console.log('        ' + fila(a)));
  console.log('\nDESPUÉS activo         en lotes             real     diferencia');
  despues.activos.forEach((a) => console.log('        ' + fila(a)));

  await app.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
