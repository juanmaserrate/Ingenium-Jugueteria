import { prisma } from '../db.js';
import { randomId } from '../utils/crypto.js';
import { logAudit, AUDIT_ACTIONS } from '../utils/audit.js';
import { cancelSale } from './sales.js';
import { reactivateSenasOfSale } from './senas.js';
import { processReturn } from './returns.js';
import { notifyPush } from './push.js';

// Venta web (Mercado Libre / Tienda Nube) que el cliente CANCELA después de asignada.
//
// No es una devolución en el local: la venta nunca se concretó y la plata la reintegra
// el canal. Por eso se ANULA la venta original (desaparece del día en que se vendió y
// repone el stock una sola vez, con re-push a los canales) en vez de crear una devolución
// con fecha de hoy, que restaba de las ventas del día de la cancelación.
// Además se avisa al usuario (campana del sistema + push a la app móvil).

type Channel = 'ml' | 'tn';
const CHANNEL_LABEL: Record<Channel, string> = { ml: 'Mercado Libre', tn: 'Tienda Nube' };

const money = (n: number) => `$${Math.round(Number(n) || 0).toLocaleString('es-AR')}`;
const dayAR = (d: Date) => new Date(d.getTime() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10).split('-').reverse().slice(0, 2).join('/');

export async function annulCancelledWebSale(saleId: string, info: { channel: Channel; orderRef: string }) {
  const sale = await prisma.sale.findUnique({ where: { id: saleId }, include: { branch: true, items: true } });
  if (!sale || sale.status !== 'confirmed') return { skipped: 'sale not confirmed' };
  const reason = `Orden ${CHANNEL_LABEL[info.channel]} #${info.orderRef} cancelada por el cliente`;
  const items = sale.items.map((i) => i.productNameSnap).filter(Boolean).join(', ');

  // Si la venta ya tuvo devoluciones (p. ej. una edición parcial de la orden en TN),
  // anularla entera repondría de más: se devuelve solo lo que queda, como antes.
  const prev = await prisma.return.findMany({ where: { originalSaleId: sale.id } });
  if (prev.length) {
    const back = new Map<string, number>();
    for (const r of prev) for (const it of ((r.returnedItems as any[]) ?? [])) back.set(it.variantId, (back.get(it.variantId) ?? 0) + (Number(it.qty) || 0));
    const rest = sale.items
      .map((it) => ({ variantId: it.variantId, qty: it.qty - (back.get(it.variantId) ?? 0), unitPrice: it.unitPrice }))
      .filter((it) => it.qty > 0);
    if (rest.length) {
      await processReturn({
        branchId: sale.branchId, originalSaleId: sale.id, customerId: sale.customerId,
        returnedItems: rest, takenItems: [], reason,
        source: info.channel === 'ml' ? 'ml_cancelled' : 'tn_cancelled',
        tnOrderId: info.channel === 'tn' ? info.orderRef : undefined,
      });
    }
    await notifyWebCancel({
      channel: info.channel, orderRef: info.orderRef, total: sale.total, items, branchId: sale.branchId,
      detail: `La venta #${sale.number} ya tenía una devolución parcial: se registró la devolución de lo que quedaba y el stock volvió a la sucursal.`,
    });
    return { ok: true, partialReturn: true };
  }

  await cancelSale(sale.id, { reason });
  await notifyWebCancel({
    channel: info.channel, orderRef: info.orderRef, total: sale.total, items, branchId: sale.branchId,
    detail: `Se anuló la venta #${sale.number} de ${sale.branch?.name ?? sale.branchId} (${dayAR(sale.datetime)}) y el stock volvió a la sucursal. No afecta las ventas de hoy.`,
  });
  return { ok: true, annulled: sale.id };
}

// Aviso al usuario. Best-effort: nunca frena el webhook.
export async function notifyWebCancel(n: {
  channel: Channel; orderRef: string; total: number; items?: string; branchId?: string | null; detail: string;
}) {
  const title = `Venta de ${CHANNEL_LABEL[n.channel]} cancelada`;
  const body = `Orden #${n.orderRef} · ${money(n.total)}${n.items ? ` · ${n.items}` : ''}. ${n.detail}`;
  try {
    // Misma forma que las notificaciones de la campana (src/core/notifications.js).
    const id = `ntf_${randomId()}`;
    await prisma.kvItem.create({
      data: {
        collection: 'notifications', key: id,
        value: { id, datetime: new Date().toISOString(), user_id: null, branch_id: n.branchId ?? null, type: 'warn', title, body, link: '/ventas', read_at: null } as any,
      },
    });
  } catch (e: any) { console.warn('[webCancel] no se pudo crear la notificación:', e?.message); }
  void notifyPush({ title, body, data: { type: 'sale_cancelled', channel: n.channel, order: n.orderRef } });
}

// Corrección de datos: cancelaciones web que se registraron con el criterio anterior
// (devolución con fecha del día de la cancelación). Borra esa devolución y deja la venta
// original anulada. El stock NO se toca: la devolución ya lo había repuesto.
export async function convertCancelReturns(opts: { dryRun?: boolean; userId?: string } = {}) {
  const returns = await prisma.return.findMany({ where: { source: { in: ['ml_cancelled', 'tn_cancelled'] }, originalSaleId: { not: null } } });
  const out: any[] = [];
  for (const r of returns) {
    const sale = await prisma.sale.findUnique({ where: { id: r.originalSaleId! }, include: { items: true } });
    if (!sale || sale.status !== 'confirmed') { out.push({ returnId: r.id, skipped: 'sale not confirmed' }); continue; }
    // Solo si la devolución cubrió la venta entera (una cancelación completa).
    const back = new Map<string, number>();
    for (const it of ((r.returnedItems as any[]) ?? [])) back.set(it.variantId, (back.get(it.variantId) ?? 0) + (Number(it.qty) || 0));
    const full = sale.items.every((it) => (back.get(it.variantId) ?? 0) === it.qty) && ((r.takenItems as any[]) ?? []).length === 0;
    if (!full) { out.push({ returnId: r.id, saleNumber: sale.number, skipped: 'devolución parcial' }); continue; }
    const row = { returnId: r.id, saleId: sale.id, saleNumber: sale.number, total: sale.total, returnedAt: r.datetime, saleAt: sale.datetime };
    if (opts.dryRun) { out.push({ ...row, dryRun: true }); continue; }
    await prisma.$transaction(async (tx) => {
      const guard = await tx.sale.updateMany({ where: { id: sale.id, status: 'confirmed' }, data: { status: 'cancelled' } });
      if (guard.count !== 1) throw new Error('La venta ya no está confirmada');
      await tx.cashMovement.deleteMany({ where: { refId: r.id } });
      await tx.return.delete({ where: { id: r.id } });
      await reactivateSenasOfSale(sale.id, { userId: opts.userId ?? null, tx });
    });
    await logAudit({
      userId: opts.userId, action: AUDIT_ACTIONS.SALE_CANCELLED, entity: 'sale', entityId: sale.id,
      description: `${r.reason ?? 'Cancelación web'} — se anula la venta en vez de la devolución del ${r.datetime.toISOString().slice(0, 10)}`,
    });
    out.push({ ...row, ok: true });
  }
  return out;
}
