import { prisma } from '../db.js';
import { logAudit, AUDIT_ACTIONS } from '../utils/audit.js';

// Limpieza ÚNICA de los datos de prueba del módulo Señas (2026-11-19), pedida por el dueño el
// 2026-11-20: la venta #603 (anulada), la seña #3 (cancelada) y el cliente "PRUEBA SISTEMA".
// Va por id exacto y con guardas: si algo no coincide con la prueba, no borra nada. Idempotente
// (la segunda vez no encuentra los registros y sale).
const TEST = {
  saleId: 'feec4e168de5bfcd4e0ae47758199935',
  senaId: '3971fa589ea460e4bfb4d2d1e1559131',
  customerId: '2c44f4116666ecc8163b2d3de94273b6',
};

export async function cleanupSenaTestData() {
  const [sale, sena, customer] = await Promise.all([
    prisma.sale.findUnique({ where: { id: TEST.saleId } }),
    prisma.sena.findUnique({ where: { id: TEST.senaId } }),
    prisma.customer.findUnique({ where: { id: TEST.customerId } }),
  ]);
  if (!sale && !sena && !customer) return; // ya limpio

  // Guardas: tienen que ser EXACTAMENTE los registros de la prueba.
  if (customer && !customer.name.startsWith('PRUEBA SISTEMA')) return warn('el cliente no es el de prueba');
  if (sale && (sale.status !== 'cancelled' || sale.number !== 603 || sale.customerId !== TEST.customerId)) return warn('la venta no es la de prueba anulada');
  if (sena && (sena.status !== 'cancelled' || sena.customerId !== TEST.customerId)) return warn('la seña no es la de prueba cancelada');

  // La prueba fue por transferencia: no debería haber movimientos de caja. Si los hubiera y
  // no netean cero, no se toca nada (borrarlos cambiaría el saldo de la caja).
  const cash = await prisma.cashMovement.findMany({ where: { refId: { in: [TEST.saleId, TEST.senaId] } }, select: { id: true, amountIn: true, amountOut: true } });
  const net = cash.reduce((s, m) => s + m.amountIn - m.amountOut, 0);
  if (cash.length && Math.abs(net) > 0.009) return warn(`hay movimientos de caja que no netean cero (${net})`);

  // El cliente de prueba no puede tener nada más que esta venta y esta seña.
  const [otherSales, otherSenas, returns] = await Promise.all([
    prisma.sale.count({ where: { customerId: TEST.customerId, id: { not: TEST.saleId } } }),
    prisma.sena.count({ where: { customerId: TEST.customerId, id: { not: TEST.senaId } } }),
    prisma.return.count({ where: { OR: [{ customerId: TEST.customerId }, { originalSaleId: TEST.saleId }] } }),
  ]);
  if (otherSales || otherSenas || returns) return warn('el cliente de prueba tiene otros registros');

  await prisma.$transaction(async (tx) => {
    if (cash.length) await tx.cashMovement.deleteMany({ where: { id: { in: cash.map((m) => m.id) } } });
    if (sale) await tx.sale.delete({ where: { id: TEST.saleId } }); // ítems y pagos caen en cascada
    if (sena) await tx.sena.delete({ where: { id: TEST.senaId } });
    if (customer) await tx.customer.delete({ where: { id: TEST.customerId } });
    // Si no quedó ninguna seña de esa sucursal, la numeración vuelve a empezar: la primera
    // seña real será la #1 (el contador había avanzado solo por las pruebas).
    if (sena) {
      const left = await tx.sena.count({ where: { branchId: sena.branchId } });
      if (left === 0) await tx.counter.updateMany({ where: { name: `sena_${sena.branchId}_${sena.createdAt.getFullYear()}` }, data: { value: 0 } });
    }
  });

  await logAudit({
    action: AUDIT_ACTIONS.DELETE, entity: 'test_data', entityId: TEST.saleId,
    before: { sale: sale ? { number: sale.number, status: sale.status } : null, sena: sena ? { number: sena.number, amount: sena.amount } : null, customer: customer?.name ?? null },
    description: 'Limpieza de datos de prueba del módulo Señas (venta #603, seña #3, cliente PRUEBA SISTEMA)',
  }).catch(() => {});
  console.log('[cleanup] datos de prueba de Señas eliminados');
}

function warn(why: string) {
  console.warn(`[cleanup] NO se borraron los datos de prueba de Señas: ${why}`);
}
