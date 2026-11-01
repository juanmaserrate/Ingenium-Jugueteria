import { prisma } from '../db.js';
import { Prisma } from '@prisma/client';
import { requireMlClient, getMlClient } from './client.js';
import { processReturn } from '../services/returns.js';
import { randomId } from '../utils/crypto.js';

// Procesa una notificación de Mercado Libre. Las notificaciones son "finas": traen un
// resource (ej. "/orders/123") y hay que ir a buscar el detalle con nuestro token. La
// notificación NO viene firmada, así que la AUTENTICIDAD se valida yendo a buscar la orden
// con nuestro token (solo vemos nuestras órdenes) y verificando que seller.id sea el nuestro.
export async function handleMlNotification(notif: any) {
  const topic = String(notif?.topic ?? '');
  const resource = String(notif?.resource ?? '');
  const m = resource.match(/\/orders\/(\d+)/);
  if (!/order/.test(topic) && !m) return { skipped: `topic ${topic}` };
  if (!m) return { skipped: 'sin order id' };
  const mlOrderId = m[1];

  const ml = await requireMlClient();
  const order = await ml.getOrder(mlOrderId);

  // Verificación de autenticidad: la orden debe ser de NUESTRO vendedor.
  const integ = await prisma.integration.findUnique({ where: { provider: 'mercadolibre' } });
  const sellerId = integ?.mlUserId;
  if (sellerId && order?.seller?.id && String(order.seller.id) !== String(sellerId)) {
    return { skipped: 'seller mismatch' };
  }

  const status = String(order?.status ?? '');
  if (status === 'paid') return ingestPaidMlOrder(order);
  if (status === 'cancelled') return handleMlOrderCancelled(order);
  return { skipped: `status ${status}` };
}

// Crea la orden pendiente local + notificación a partir de una orden de ML ya traída.
// Idempotente por mlOrderId. La usan el webhook y el respaldo (reconcileMlOrders).
export async function ingestPaidMlOrder(order: any) {
  const mlOrderId = String(order.id);
  const existing = await prisma.mlOrderPending.findUnique({ where: { mlOrderId } });
  if (existing) return { skipped: 'already received' };

  const buyer = order.buyer ?? {};
  const customerName = [buyer.first_name, buyer.last_name].filter(Boolean).join(' ') || buyer.nickname || 'Sin nombre';
  const items = (order.order_items ?? []).map((oi: any) => ({
    mlItemId: String(oi?.item?.id ?? ''),
    mlVariationId: oi?.item?.variation_id != null ? String(oi.item.variation_id) : null,
    qty: Number(oi?.quantity) || 0,
    unitPrice: Number(oi?.unit_price) || 0,
    title: oi?.item?.title ?? '',
    saleFee: Number(oi?.sale_fee) || 0,
  }));

  try {
    await prisma.mlOrderPending.create({
      data: {
        mlOrderId,
        number: order.pack_id ? String(order.pack_id) : String(mlOrderId),
        customerName,
        customerEmail: buyer.email ?? null,
        customerPhone: null,
        items: items as any,
        total: Number(order.total_amount) || 0,
        currency: order.currency_id ?? 'ARS',
        paymentStatus: order.status ?? 'paid',
        rawPayload: order as any,
        status: 'pending',
      },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return { skipped: 'already received (race)' };
    }
    throw e;
  }

  await prisma.notification.create({
    data: {
      id: randomId(),
      type: 'ml_order',
      title: 'Nueva venta de Mercado Libre',
      message: `Orden #${mlOrderId} - $${order.total_amount}. Asignar sucursal.`,
      data: { mlOrderId } as any,
    },
  });

  return { ok: true, mlOrderId };
}

// Orden cancelada: si ya era venta en Ingenium, crea la devolución (restock + re-push a
// todos los canales vía el fan-out de enqueueSync). Guarda atómica anti-doble-devolución.
export async function handleMlOrderCancelled(order: any) {
  const mlOrderId = String(order.id);
  const pending = await prisma.mlOrderPending.findUnique({ where: { mlOrderId } });
  if (!pending) return { skipped: 'unknown order' };

  const flip = await prisma.mlOrderPending.updateMany({
    where: { mlOrderId, status: { not: 'cancelled' } },
    data: { status: 'cancelled' },
  });
  if (flip.count !== 1) return { skipped: 'already cancelled' };

  if (pending.status === 'assigned' && pending.assignedSaleId) {
    const sale = await prisma.sale.findUnique({ where: { id: pending.assignedSaleId }, include: { items: true } });
    if (sale && sale.status === 'confirmed') {
      await processReturn({
        branchId: sale.branchId,
        originalSaleId: sale.id,
        customerId: sale.customerId,
        returnedItems: sale.items.map((it) => ({ variantId: it.variantId, qty: it.qty, unitPrice: it.unitPrice })),
        takenItems: [],
        reason: `Orden ML #${mlOrderId} cancelada`,
        source: 'ml_cancelled',
      });
    }
  }
  return { ok: true };
}

// --- Respaldo: reconcilia órdenes que se hayan perdido por un webhook no entregado ---
let lastReconcileAt = 0;
let reconcileInFlight = false;
const RECONCILE_THROTTLE_MS = 3 * 60 * 1000;

export async function reconcileMlOrders(): Promise<{ scanned: number; ingested: number } | null> {
  const ml = await getMlClient();
  if (!ml) return null;
  const integ = await prisma.integration.findUnique({ where: { provider: 'mercadolibre' } });
  if (!integ?.mlUserId) return null;
  let scanned = 0, ingested = 0;
  for (let offset = 0; offset < 200; offset += 50) {
    let res: any;
    try {
      res = await ml.searchOrders({ seller: integ.mlUserId, 'order.status': 'paid', sort: 'date_desc', offset, limit: 50 });
    } catch { break; }
    const results = res?.results ?? [];
    if (!results.length) break;
    for (const order of results) {
      scanned++;
      const mlOrderId = String(order.id);
      const existing = await prisma.mlOrderPending.findUnique({ where: { mlOrderId } });
      if (existing) continue;
      try { await ingestPaidMlOrder(order); ingested++; } catch { /* seguir */ }
    }
    if (results.length < 50) break;
  }
  return { scanned, ingested };
}

export function maybeReconcileMl() {
  if (reconcileInFlight) return;
  if (Date.now() - lastReconcileAt < RECONCILE_THROTTLE_MS) return;
  lastReconcileAt = Date.now();
  reconcileInFlight = true;
  reconcileMlOrders().catch(() => {}).finally(() => { reconcileInFlight = false; });
}
