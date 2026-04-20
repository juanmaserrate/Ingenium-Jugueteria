// Movimientos de caja: ventas efvo, devoluciones efvo, gastos, apertura, cierre, ajustes.
import { put, getAll, newId } from '../core/db.js';
import * as Audit from '../core/audit.js';
import { emit, EV } from '../core/events.js';
import { todayKey } from '../core/format.js';

export async function balance(branchId) {
  const all = await getAll('cash_movements');
  return all.filter(m => m.branch_id === branchId)
    .reduce((s, m) => s + (m.amount_in || 0) - (m.amount_out || 0), 0);
}

// ¿Hay apertura de caja hoy y todavía no se cerró?
export async function isDayOpen(branchId) {
  const all = await getAll('cash_movements');
  const today = todayKey();
  const todays = all.filter(m => m.branch_id === branchId && m.datetime?.startsWith(today));
  const opened = todays.some(m => m.type === 'opening');
  const closed = todays.some(m => m.type === 'closing');
  return opened && !closed;
}

export async function balanceAt(branchId, isoDateTime) {
  const all = await getAll('cash_movements');
  return all.filter(m => m.branch_id === branchId && m.datetime <= isoDateTime)
    .reduce((s, m) => s + (m.amount_in || 0) - (m.amount_out || 0), 0);
}

export async function move({ branchId, type, amountIn = 0, amountOut = 0, description = '', refId = null, userId = null }) {
  const cur = await balance(branchId);
  const mv = {
    id: newId('cm'),
    type,
    datetime: new Date().toISOString(),
    branch_id: branchId,
    amount_in: Number(amountIn) || 0,
    amount_out: Number(amountOut) || 0,
    balance_after: cur + (Number(amountIn) || 0) - (Number(amountOut) || 0),
    description,
    ref_id: refId,
    user_id: userId,
  };
  await put('cash_movements', mv);
  await Audit.log({
    action: 'cash_move', entity: 'caja', entity_id: mv.id,
    after: mv, description: `${type} — ${description} (${mv.amount_in ? '+' : '-'}${mv.amount_in || mv.amount_out})`,
  });
  emit(EV.CASH_MOVED, mv);
  return mv;
}

export async function openDay(branchId, initialAmount, userId) {
  const all = await getAll('cash_movements');
  const already = all.find(m => m.branch_id === branchId && m.type === 'opening' && m.datetime.startsWith(todayKey()));
  if (already) throw new Error('La caja ya fue abierta hoy');
  return move({ branchId, type: 'opening', amountIn: initialAmount, description: 'Apertura de caja', userId });
}

export async function closeDay(branchId, countedAmount, userId) {
  const expected = await balance(branchId);
  const diff = countedAmount - expected;
  return move({
    branchId, type: 'closing',
    amountIn: diff > 0 ? diff : 0,
    amountOut: diff < 0 ? -diff : 0,
    description: `Cierre de caja · Esperado ${expected.toFixed(2)} / Contado ${countedAmount.toFixed(2)} / Dif ${diff.toFixed(2)}`,
    userId,
  });
}

export async function addExpense({ branchId, amount, category, description, paymentMethodId, userId }) {
  const exp = {
    id: newId('exp'),
    datetime: new Date().toISOString(),
    branch_id: branchId,
    amount: Number(amount) || 0,
    category: category || 'General',
    description,
    payment_method_id: paymentMethodId,
    user_id: userId,
  };
  await put('expenses', exp);
  await Audit.log({ action: 'create', entity: 'gasto', entity_id: exp.id, after: exp, description: `Gasto ${category}: ${description}` });
  if (paymentMethodId === 'cash') {
    await move({ branchId, type: 'expense', amountOut: exp.amount, description: `Gasto: ${description}`, refId: exp.id, userId });
  }
  return exp;
}
