// Ventas (frontend): helpers de cálculo de totales y persistencia de borradores.
// NOTA: la confirmación/cancelación de ventas YA NO vive acá — el POS postea directo a
// /api/sales (y /api/sales/:id/cancel) contra el backend, que es la fuente de verdad y
// hace stock + caja + auditoría de forma atómica. Antes había acá una versión offline
// (IndexedDB) que quedó obsoleta con la migración "todo online" y se eliminó.
import { put, getAll, newId, del } from '../core/db.js';
import { round2 } from '../core/format.js';

export function computeTotals(sale) {
  const itemsSubtotal = round2((sale.items || []).reduce((s, it) => s + (it.subtotal || 0), 0));
  const globalDiscount = round2((sale.discount_global_pct ? itemsSubtotal * sale.discount_global_pct / 100 : 0) + (sale.discount_global_fixed || 0));
  const globalSurcharge = round2((sale.surcharge_global_pct ? itemsSubtotal * sale.surcharge_global_pct / 100 : 0) + (sale.surcharge_global_fixed || 0));
  const total = round2(Math.max(0, itemsSubtotal - globalDiscount + globalSurcharge));
  return { items_subtotal: itemsSubtotal, discount_total: globalDiscount, surcharge_total: globalSurcharge, total };
}

export function computeItemSubtotal(item) {
  const base = (Number(item.qty) || 0) * (Number(item.unit_price) || 0);
  const d = (item.discount_pct ? base * item.discount_pct / 100 : 0) + (item.discount_fixed || 0);
  return round2(Math.max(0, base - d));
}

// Draft: persistencia de ventas en curso (multi-pestaña)
export async function saveDraft(draft) {
  const rec = { ...draft, id: draft.id || newId('draft'), updated_at: new Date().toISOString() };
  await put('draft_sales', rec);
  return rec;
}
export async function listDrafts() { return getAll('draft_sales'); }
export async function removeDraft(id) {
  await del('draft_sales', id);
}
