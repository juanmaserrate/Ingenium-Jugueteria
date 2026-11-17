import { prisma } from '../db.js';
import { sumPendingForVariant, type MlPendingItem, type TnPendingItem } from './pendingMath.js';

// =========================================================
// RESERVA DE VENTAS ONLINE PENDIENTES
// Una venta de Mercado Libre / Tienda Nube entra como "pendiente" hasta que se la asigna a
// una sucursal (recién ahí baja el stock físico). Mientras tanto esas unidades YA están
// vendidas: si no se descuentan del stock PUBLICADO, el otro canal las sigue ofreciendo y
// un push de stock se las "devuelve" al canal que las vendió (sobreventa).
// Acá se calcula cuánto hay comprometido por variante; computeTn/MlStockForVariant lo restan.
// =========================================================

// Solo cuentan pendientes recientes: una orden vieja que nunca se asignó no debe retener
// stock para siempre.
export const PENDING_WINDOW_DAYS = 30;

// La reserva arranca con el deploy que la introdujo: las pendientes recibidas ANTES (backlog
// e historial importado al conectar ML) nunca reservan — su stock se descuenta, como siempre,
// recién al asignarlas.
export const RESERVE_FROM = new Date('2026-11-17T16:40:00Z');

const windowStart = () => {
  const w = Date.now() - PENDING_WINDOW_DAYS * 24 * 3600 * 1000;
  return new Date(Math.max(w, RESERVE_FROM.getTime()));
};

// Unidades de la variante comprometidas en ventas online todavía sin asignar.
export async function pendingWebQtyForVariant(variantId: string): Promise<number> {
  try {
    const [mlMap, tnMap] = await Promise.all([
      prisma.variantMeliMapping.findUnique({ where: { variantId } }).catch(() => null),
      prisma.variantTnMapping.findUnique({ where: { variantId } }).catch(() => null),
    ]);
    if (!mlMap && !tnMap) return 0;

    const since = windowStart();
    const [mlOrders, tnOrders, siblings] = await Promise.all([
      mlMap
        ? prisma.mlOrderPending.findMany({ where: { status: { in: ['pending', 'assigning'] }, receivedAt: { gte: since } }, select: { items: true } }).catch(() => [])
        : Promise.resolve([]),
      tnMap
        ? prisma.tnOrderPending.findMany({ where: { status: { in: ['pending', 'assigning'] }, receivedAt: { gte: since } }, select: { items: true } }).catch(() => [])
        : Promise.resolve([]),
      mlMap
        ? prisma.variantMeliMapping.findMany({ where: { mlItemId: mlMap.mlItemId, NOT: { variantId } }, select: { mlVariationId: true } }).catch(() => [])
        : Promise.resolve([]),
    ]);

    return sumPendingForVariant({
      ml: mlMap
        ? {
            mlItemId: mlMap.mlItemId,
            mlVariationId: mlMap.mlVariationId ?? null,
            otherVariationIds: (siblings as any[]).map((s) => s.mlVariationId).filter(Boolean),
          }
        : null,
      mlOrders: mlOrders as any,
      tnVariantId: tnMap?.tnVariantId ?? null,
      tnOrders: tnOrders as any,
    });
  } catch {
    return 0; // ante cualquier problema no se reserva nada (comportamiento previo)
  }
}

// Variantes locales afectadas por los ítems de una orden ML (item + variación opcional).
export async function variantIdsForMlItems(items: MlPendingItem[]): Promise<string[]> {
  const out = new Set<string>();
  for (const it of Array.isArray(items) ? items : []) {
    const mlItemId = String(it?.mlItemId ?? '');
    if (!mlItemId) continue;
    const maps = await prisma.variantMeliMapping.findMany({ where: { mlItemId } }).catch(() => []);
    if (!maps.length) continue;
    const itVar = it.mlVariationId != null && it.mlVariationId !== '' ? String(it.mlVariationId) : null;
    const hit = (itVar && maps.find((m) => m.mlVariationId === itVar)) || maps.find((m) => !m.mlVariationId) || maps[0];
    if (hit) out.add(hit.variantId);
  }
  return [...out];
}

// Variantes locales afectadas por los ítems de una orden TN.
export async function variantIdsForTnItems(items: TnPendingItem[]): Promise<string[]> {
  const ids = (Array.isArray(items) ? items : []).map((it) => String(it?.tnVariantId ?? '')).filter(Boolean);
  if (!ids.length) return [];
  const maps = await prisma.variantTnMapping.findMany({ where: { tnVariantId: { in: ids } }, select: { variantId: true } }).catch(() => []);
  return [...new Set(maps.map((m) => m.variantId))];
}

// Re-publica el stock (a TN y, por el fan-out de la cola, a ML) de las variantes de una orden
// online. Se llama cuando la orden entra, se cancela o se asigna. Nunca falla hacia afuera.
export async function repushStockForOrderItems(channel: 'ml' | 'tn', items: unknown): Promise<void> {
  try {
    const { enqueueSync } = await import('../sync/queue.js');
    const variantIds = channel === 'ml'
      ? await variantIdsForMlItems(items as MlPendingItem[])
      : await variantIdsForTnItems(items as TnPendingItem[]);
    for (const variantId of variantIds) await enqueueSync('push_stock', { variantId });
  } catch { /* best-effort */ }
}
