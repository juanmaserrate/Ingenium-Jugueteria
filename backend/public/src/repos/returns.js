// Devoluciones — MIGRADO A "TODO ONLINE".
// El backend (POST /api/returns) reingresa stock, descuenta cambios, emite el vale
// y registra el movimiento de caja, todo atómico. Acá sólo mapeamos el shape del
// front (snake_case, product_id) al del backend (camelCase, variantId).

import { api } from '../core/api.js';
import { get } from '../core/db.js';
import { variantIdOf } from './products.js';
import { emit, EV } from '../core/events.js';
import { round2 } from '../core/format.js';

export async function list() {
  return api('/api/returns');
}

export async function listCreditNotes() {
  return api('/api/credit-notes');
}

function totalOf(items) {
  return round2((items || []).reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.unit_price) || 0), 0));
}

// Mapea items del front a {variantId, qty, unitPrice}, resolviendo variantId del backend.
async function mapItems(items) {
  const out = [];
  for (const it of items || []) {
    const variantId = it.variant_id || (await variantIdOf(it.product_id));
    if (!variantId) throw new Error(`"${it.name || it.product_id}" no está sincronizado con el servidor`);
    out.push({ variantId, qty: Number(it.qty) || 0, unitPrice: Number(it.unit_price) || 0 });
  }
  return out;
}

/**
 * Procesa una devolución/cambio contra el backend.
 * payload (front): returned_items, taken_items, refund_payments[{method_id, amount}],
 *   emit_credit_note, customer_id, original_sale_id, reason, branchId, userId.
 */
export async function process(payload) {
  const {
    returned_items = [], taken_items = [], refund_payments = [],
    emit_credit_note = false, customer_id = null, branchId,
    original_sale_id = null, reason = '',
  } = payload;

  const hasItems = returned_items.length > 0 || taken_items.length > 0;
  const hasPayments = refund_payments.some(p => (Number(p.amount) || 0) !== 0);
  if (!hasItems && !hasPayments) throw new Error('Debe haber items o un monto de devolución');

  const methodsCfg = ((await get('config', 'payment_methods'))?.value) || [];
  const methodName = (id) => methodsCfg.find(m => m.id === id)?.name || id;

  const body = {
    branchId,
    originalSaleId: original_sale_id || null,
    customerId: customer_id || null,
    returnedItems: await mapItems(returned_items),
    takenItems: await mapItems(taken_items),
    refundPayments: (refund_payments || [])
      .filter(p => (Number(p.amount) || 0) !== 0)
      .map(p => ({ methodId: p.method_id, methodName: methodName(p.method_id), amount: Number(p.amount) || 0 })),
    emitCreditNote: !!emit_credit_note,
    reason: reason || undefined,
  };

  const rec = await api('/api/returns', { method: 'POST', body });
  emit(EV.RETURN_CONFIRMED, rec);
  emit(EV.STOCK_CHANGED, { branch_id: branchId });
  return rec;
}
