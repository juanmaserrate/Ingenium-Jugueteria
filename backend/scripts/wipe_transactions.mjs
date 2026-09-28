// Borra TODAS las ventas, devoluciones y movimientos de caja de la base.
// Uso (contra produccion, via Railway):
//   cd backend
//   railway run --service Postgres node scripts/wipe_transactions.mjs --yes
//
// - Devoluciones se borran ANTES que las ventas (FK Return.originalSale -> Sale sin cascade).
// - Borrar ventas cascada sus items (sale_items) y pagos (sale_payments).
// - Reinicia los contadores de numeracion de ventas/devoluciones para empezar de #1.
// - NO toca productos, stock, clientes ni catalogo.

if (process.env.DATABASE_PUBLIC_URL) process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;

import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  if (!process.argv.includes('--yes')) {
    console.log('ATENCION: esto borra TODAS las ventas, devoluciones y movimientos de caja.');
    console.log('Para confirmar, volve a correrlo agregando  --yes  al final.');
    const [ventas, devol, caja] = await Promise.all([
      prisma.sale.count(), prisma.return.count(), prisma.cashMovement.count(),
    ]);
    console.log(`Se borrarian: ${ventas} ventas, ${devol} devoluciones, ${caja} movimientos de caja.`);
    return;
  }

  const antes = {
    ventas: await prisma.sale.count(),
    devoluciones: await prisma.return.count(),
    caja: await prisma.cashMovement.count(),
  };
  console.log('Antes:', antes);

  // 1) Devoluciones primero (referencian ventas sin cascade)
  const delRet = await prisma.return.deleteMany({});
  console.log('devoluciones borradas:', delRet.count);

  // 2) Movimientos de caja (refId es texto, sin FK)
  const delCash = await prisma.cashMovement.deleteMany({});
  console.log('movimientos de caja borrados:', delCash.count);

  // 3) Ventas (cascada sale_items + sale_payments)
  const delSales = await prisma.sale.deleteMany({});
  console.log('ventas borradas (cascada items+pagos):', delSales.count);

  // 4) Reiniciar numeracion de ventas y devoluciones
  const rc1 = await prisma.counter.updateMany({ where: { name: { startsWith: 'sale_' } }, data: { value: 0 } });
  const rc2 = await prisma.counter.updateMany({ where: { name: { startsWith: 'return_' } }, data: { value: 0 } });
  console.log('contadores de venta reiniciados:', rc1.count, '| de devolucion:', rc2.count);

  const despues = {
    ventas: await prisma.sale.count(),
    devoluciones: await prisma.return.count(),
    caja: await prisma.cashMovement.count(),
  };
  console.log('Despues:', despues);
  console.log('LISTO. Productos, stock, clientes y catalogo quedaron intactos.');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => { console.error('ERROR:', e.message); await prisma.$disconnect(); process.exit(1); });
