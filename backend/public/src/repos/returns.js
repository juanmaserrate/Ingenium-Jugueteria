// Devoluciones: reingreso de stock, impacto de caja, emisión de vale si corresponde.
import { put, get, getAll, newId, stockId } from '../core/db.js';
import * as Audit from '../core/audit.js';
import * as Cash from './cash.js';
import { next as nextCounter } from './counters.js';
import { emit, EV } from '../core/events.js';
import { round2 } from '../core/format.js';

export async function list() { return getAll('returns'); }

function totalOf(items) {
  return round2(items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.unit_price) || 0), 0));
}

/**
 * Procesa una devolución/cambio.
 * payload:
 *  - returned_items: [{product_id, qty, unit_price}] (lo que el cliente trae y vuelve al stock)
 *  - taken_items:    [{product_id, qty, unit_price}] (lo que el cliente se lleva a cambio, puede estar vacío)
 *  - refund_payments: [{method_id, amount}] (flujo de dinero; positivo=cobra la tienda, negativo=paga la tienda)
 *  - emit_credit_note: bool (si diferencia a favor cliente, emite vale en vez de devolver efvo)
 *  - customer_id: string|null
 *  - branchId, userId
 *
 * Impacto:
 *  - Facturado: SIEMPRE se ajusta (lleva - devuelto; en devolución pura, suma los pagos).
 *  - Caja: sólo los pagos en efectivo impactan saldo de caja.
 */
export async function process(payload) {
  const { returned_items = [], taken_items = [], refund_payments = [], emit_credit_note = false, customer_id = null, branchId, userId, original_sale_id = null, reason = '' } = payload;
  const hasItems = returned_items.length > 0 || taken_items.length > 0;
  const hasPayments = refund_payments.some(p => (Number(p.amount) || 0) !== 0);
  if (!hasItems && !hasPayments) throw new Error('Debe haber items o un monto de devolución');

  const returnedTotal = totalOf(returned_items);
  const takenTotal    = totalOf(taken_items);
  const difference    = round2(takenTotal - returnedTotal); // >0 cliente paga, <0 cliente recibe

  // Delta de facturación neto. Sin items, se toma el flujo de pagos (devolución pura).
  const paymentsNet = round2(refund_payments.reduce((s, p) => s + (Number(p.amount) || 0), 0));
  const invoicedDelta = hasItems ? difference : paymentsNet;

  // Validar que la caja esté abierta si hay movimiento en efectivo
  const methodsCfg = ((await get('config', 'payment_methods'))?.value) || [];
  const anyCash = refund_payments.some(p => {
    const m = methodsCfg.find(x => x.id === p.method_id);
    return m?.affects_cash && (Number(p.amount) || 0) !== 0;
  });
  if (anyCash && !(await Cash.isDayOpen(branchId))) {
    throw new Error('La caja está cerrada. Abrí la caja antes de registrar movimientos en efectivo.');
  }

  const number = await nextCounter('return_number');
  const rec = {
    id: newId('ret'),
    number,
    datetime: new Date().toISOString(),
    branch_id: branchId,
    original_sale_id,
    customer_id,
    returned_items,
    taken_items,
    returned_total: returnedTotal,
    taken_total: takenTotal,
    difference,
    invoiced_delta: invoicedDelta,
    payments: refund_payments,
    reason,
    credit_note_id: null,
    user_id: userId,
  };

  // Ajustes de stock
  for (const it of returned_items) {
    const sk = stockId(it.product_id, branchId);
    const st = (await get('stock', sk)) || { id: sk, product_id: it.product_id, branch_id: branchId, qty: 0, reserved_qty: 0 };
    st.qty = (st.qty || 0) + Number(it.qty || 0);
    await put('stock', st);
  }
  for (const it of taken_items) {
    const sk = stockId(it.product_id, branchId);
    const st = (await get('stock', sk)) || { id: sk, product_id: it.product_id, branch_id: branchId, qty: 0, reserved_qty: 0 };
    st.qty = Math.max(0, (st.qty || 0) - Number(it.qty || 0));
    await put('stock', st);
  }

  // Vale si hay saldo a favor del cliente y pidió vale
  const creditableAmount = hasItems ? -difference : -paymentsNet;
  if (emit_credit_note && creditableAmount > 0) {
    const cnCount = await nextCounter('credit_note');
    const cnCfg = await get('config', 'credit_note_months');
    const months = cnCfg?.value || 6;
    const exp = new Date(); exp.setMonth(exp.getMonth() + months);
    const cn = {
      id: newId('cn'),
      code: `VALE-${String(cnCount).padStart(6, '0')}`,
      customer_id,
      amount: round2(creditableAmount),
      issued_at: new Date().toISOString(),
      expires_at: exp.toISOString(),
      redeemed_at: null,
      redeemed_in_sale_id: null,
      branch_id: branchId,
      return_id: rec.id,
    };
    await put('credit_notes', cn);
    rec.credit_note_id = cn.id;
    rec.credit_note_code = cn.code;
  }

  await put('returns', rec);

  // Impacto en caja: solo lo efvo
  const methods = ((await get('config', 'payment_methods'))?.value) || [];
  for (const pay of refund_payments) {
    const m = methods.find(x => x.id === pay.method_id);
    if (!m?.affects_cash) continue;
    const amt = Number(pay.amount) || 0;
    if (amt > 0) {
      // Cliente paga diferencia en efvo → entra a caja
      await Cash.move({ branchId, type: 'return', amountIn: amt, description: `Dev #${number} · Cobro diferencia`, refId: rec.id, userId });
    } else if (amt < 0) {
      // Devolución efvo al cliente → sale de caja
      await Cash.move({ branchId, type: 'return', amountOut: Math.abs(amt), description: `Dev #${number} · Devolución efvo`, refId: rec.id, userId });
    }
  }

  await Audit.log({
    action: 'confirm', entity: 'devolucion', entity_id: rec.id,
    after: rec,
    description: `Devolución #${number} · Dev: ${returnedTotals.total.toFixed(2)} · Lleva: ${takenTotals.total.toFixed(2)} · Dif: ${difference.toFixed(2)}`,
  });
  emit(EV.RETURN_CONFIRMED, rec);
  emit(EV.STOCK_CHANGED, { branch_id: branchId });
  return rec;
}

export async function redeemCreditNote(code) {
  const all = await getAll('credit_notes');
  const cn = all.find(c => c.code === code);
  if (!cn) throw new Error('Vale no encontrado');
  if (cn.redeemed_at) throw new Error('Vale ya utilizado');
  if (cn.expires_at && cn.expires_at < new Date().toISOString()) throw new Error('Vale vencido');
  return cn;
}

export async function markCreditNoteRedeemed(cnId, saleId) {
  const cn = await get('credit_notes', cnId);
  if (!cn) return;
  cn.redeemed_at = new Date().toISOString();
  cn.redeemed_in_sale_id = saleId;
  await put('credit_notes', cn);
}
