// Ventas: confirma, actualiza stock, impacta caja, registra auditoría.
import { put, get, getAll, newId, stockId, tx } from '../core/db.js';
import * as Audit from '../core/audit.js';
import * as Cash from './cash.js';
import { next as nextCounter } from './counters.js';
import { emit, EV } from '../core/events.js';
import { round2 } from '../core/format.js';

// Error específico para que el POS pueda preguntar al usuario si permitir stock negativo
export class StockInsufficientError extends Error {
  constructor(items) {
    super(`Stock insuficiente: ${items.map(i => i.name).join(', ')}`);
    this.name = 'StockInsufficientError';
    this.items = items;
  }
}

const promisify = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export async function list() { return getAll('sales'); }
export async function byId(id) { return get('sales', id); }

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

export async function confirm(sale, { userId, branchId, allowNegative = false }) {
  if (!sale.items || sale.items.length === 0) throw new Error('La venta no tiene items');
  const totals = computeTotals(sale);
  if (sale.payments) {
    const sumP = sale.payments.reduce((s, p) => s + (Number(p.amount) || 0), 0);
    if (Math.abs(sumP - totals.total) > 0.01) {
      throw new Error(`Los pagos (${sumP.toFixed(2)}) no coinciden con el total (${totals.total.toFixed(2)})`);
    }
  }

  // Si algún pago impacta en caja, la caja debe estar abierta
  const methodsCfg = ((await get('config', 'payment_methods'))?.value) || [];
  const anyCash = (sale.payments || []).some(p => {
    const m = methodsCfg.find(x => x.id === p.method_id);
    return m?.affects_cash && (Number(p.amount) || 0) > 0;
  });
  if (anyCash && !(await Cash.isDayOpen(branchId))) {
    throw new Error('La caja está cerrada. Abrí la caja antes de registrar ventas en efectivo.');
  }

  const number = await nextCounter('sale_number');

  // Snapshot de costos por item (para Ganancias/Contribución futuros)
  for (const it of sale.items) {
    if (!it.cost_snapshot) {
      const p = await get('products', it.product_id);
      it.cost_snapshot = p?.cost || 0;
    }
    it.subtotal = computeItemSubtotal(it);
  }

  const rec = {
    id: sale.id || newId('sale'),
    number,
    datetime: new Date().toISOString(),
    branch_id: branchId,
    seller_id: sale.seller_id || null,
    customer_id: sale.customer_id || null,
    items: sale.items,
    payments: sale.payments || [],
    ...totals,
    discount_global_pct: sale.discount_global_pct || 0,
    discount_global_fixed: sale.discount_global_fixed || 0,
    surcharge_global_pct: sale.surcharge_global_pct || 0,
    surcharge_global_fixed: sale.surcharge_global_fixed || 0,
    status: 'confirmed',
  };

  // Atómico: valida stock dentro del tx y recién ahí descuenta + persiste la venta.
  // Si dos pestañas confirman simultáneamente el mismo producto, IndexedDB serializa
  // las transacciones readwrite sobre 'stock' y la segunda ve el stock ya decrementado.
  await tx(['sales', 'stock'], 'readwrite', async (stores) => {
    const insufficient = [];
    const stocksToWrite = [];
    for (const it of rec.items) {
      const sk = stockId(it.product_id, branchId);
      const st = (await promisify(stores.stock.get(sk))) || { id: sk, product_id: it.product_id, branch_id: branchId, qty: 0, reserved_qty: 0 };
      const needed = Number(it.qty) || 0;
      if ((st.qty || 0) < needed) {
        insufficient.push({ product_id: it.product_id, name: it.name, available: st.qty || 0, needed });
        if (!allowNegative) continue;
      }
      st.qty = (st.qty || 0) - needed;
      stocksToWrite.push(st);
    }
    if (insufficient.length && !allowNegative) {
      throw new StockInsufficientError(insufficient);
    }
    for (const st of stocksToWrite) await promisify(stores.stock.put(st));
    await promisify(stores.sales.put(rec));
  });

  for (const pay of rec.payments) {
    const m = methodsCfg.find(x => x.id === pay.method_id);
    if (m?.affects_cash) {
      await Cash.move({
        branchId, type: 'sale', amountIn: Number(pay.amount) || 0,
        description: `Venta #${number}`, refId: rec.id, userId,
      });
    }
  }

  await Audit.log({
    action: 'confirm', entity: 'venta', entity_id: rec.id,
    after: rec,
    description: `Venta #${number} confirmada · ${rec.items.length} items · ${rec.total.toFixed(2)}`,
  });
  emit(EV.SALE_CONFIRMED, rec);
  emit(EV.STOCK_CHANGED, { branch_id: branchId });
  return rec;
}

// U-8: cancelar una venta confirmada revirtiendo stock + caja.
export async function cancelSale(saleId, { userId, reason = 'undo' } = {}) {
  const sale = await get('sales', saleId);
  if (!sale) throw new Error('Venta no encontrada');
  if (sale.status === 'cancelled') return sale;

  await tx(['sales', 'stock'], 'readwrite', async (stores) => {
    for (const it of sale.items || []) {
      const sk = stockId(it.product_id, sale.branch_id);
      const st = (await promisify(stores.stock.get(sk))) || { id: sk, product_id: it.product_id, branch_id: sale.branch_id, qty: 0, reserved_qty: 0 };
      st.qty = (st.qty || 0) + (Number(it.qty) || 0);
      await promisify(stores.stock.put(st));
    }
    sale.status = 'cancelled';
    sale.cancelled_at = new Date().toISOString();
    sale.cancel_reason = reason;
    await promisify(stores.sales.put(sale));
  });

  const methodsCfg = ((await get('config', 'payment_methods'))?.value) || [];
  for (const pay of sale.payments || []) {
    const m = methodsCfg.find(x => x.id === pay.method_id);
    if (m?.affects_cash && (Number(pay.amount) || 0) > 0) {
      try {
        await Cash.move({
          branchId: sale.branch_id, type: 'adjustment',
          amountOut: Number(pay.amount) || 0,
          description: `Anulación venta #${sale.number}`,
          refId: sale.id, userId,
        });
      } catch (e) { /* caja cerrada: registrar sin afectar */ }
    }
  }

  await Audit.log({
    action: 'cancel', entity: 'venta', entity_id: sale.id,
    before: { status: 'confirmed' }, after: { status: 'cancelled', reason },
    description: `Venta #${sale.number} anulada (${reason})`,
  });
  emit(EV.SALE_CONFIRMED, sale);
  emit(EV.STOCK_CHANGED, { branch_id: sale.branch_id });
  return sale;
}

// Draft: persistencia de ventas en curso (multi-pestaña)
export async function saveDraft(draft) {
  const rec = { ...draft, id: draft.id || newId('draft'), updated_at: new Date().toISOString() };
  await put('draft_sales', rec);
  return rec;
}
export async function listDrafts() { return getAll('draft_sales'); }
export async function removeDraft(id) {
  const { del } = await import('../core/db.js');
  await del('draft_sales', id);
}
