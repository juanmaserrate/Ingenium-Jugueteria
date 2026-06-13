// Movimientos de caja — MIGRADO A "TODO ONLINE".
// El servidor (Postgres) es la única fuente de verdad. Mantiene las mismas firmas que
// la versión IndexedDB para no romper a los consumidores (topbar, módulo Caja, checks).

import { api } from '../core/api.js';
import { emit, EV } from '../core/events.js';

export async function balance(branchId) {
  const r = await api(`/api/cash/${encodeURIComponent(branchId)}/balance`);
  return r?.balance || 0;
}

// Lista de movimientos (shape backend → front snake_case, con balance_after calculado).
export async function listMovements(branchId) {
  const raw = await api(`/api/cash/${encodeURIComponent(branchId)}/movements`);
  let running = 0;
  return (raw || []).map((m) => {
    running += (m.amountIn || 0) - (m.amountOut || 0);
    return {
      id: m.id, type: m.type, datetime: m.datetime, branch_id: m.branchId,
      amount_in: m.amountIn || 0, amount_out: m.amountOut || 0,
      balance_after: running, description: m.description || '', ref_id: m.refId || null,
    };
  });
}

export async function listExpenses(branchId) {
  const raw = await api(`/api/cash/${encodeURIComponent(branchId)}/expenses`);
  return (raw || []).map((e) => ({
    id: e.id, datetime: e.datetime, branch_id: e.branchId, amount: e.amount,
    category: e.category || 'General', description: e.description || '',
    payment_method_id: e.paymentMethodId || 'cash',
  }));
}

// ¿Hay apertura de caja hoy y todavía no se cerró? (lo calcula el backend en hora AR)
export async function isDayOpen(branchId) {
  try {
    const s = await api(`/api/cash/${encodeURIComponent(branchId)}/status`);
    return !!s?.isOpen;
  } catch {
    return false;
  }
}

export async function dayStatus(branchId) {
  return api(`/api/cash/${encodeURIComponent(branchId)}/status`);
}

// Balance "a una fecha" — el backend no expone corte temporal; aproximamos sumando
// los movimientos hasta esa fecha desde la lista completa.
export async function balanceAt(branchId, isoDateTime) {
  const raw = await api(`/api/cash/${encodeURIComponent(branchId)}/movements`);
  return (raw || [])
    .filter((m) => new Date(m.datetime).toISOString() <= isoDateTime)
    .reduce((s, m) => s + (m.amountIn || 0) - (m.amountOut || 0), 0);
}

export async function move({ branchId, type, amountIn = 0, amountOut = 0, description = '', userId = null }) {
  const mv = await api('/api/cash/move', {
    method: 'POST',
    body: { branchId, type, amountIn: Number(amountIn) || 0, amountOut: Number(amountOut) || 0, description },
  });
  emit(EV.CASH_MOVED, mv);
  return mv;
}

export async function openDay(branchId, initialAmount, userId) {
  const r = await api('/api/cash/open', { method: 'POST', body: { branchId, initialAmount: Number(initialAmount) || 0 } });
  emit(EV.CASH_MOVED, r);
  return r;
}

export async function closeDay(branchId, countedAmount, userId) {
  const r = await api('/api/cash/close', { method: 'POST', body: { branchId, countedAmount: Number(countedAmount) || 0 } });
  emit(EV.CASH_MOVED, r);
  return r;
}

export async function addExpense({ branchId, amount, category, description, paymentMethodId, userId }) {
  const r = await api('/api/cash/expense', {
    method: 'POST',
    body: { branchId, amount: Number(amount) || 0, category: category || 'General', description, paymentMethodId },
  });
  emit(EV.CASH_MOVED, r);
  return r;
}
