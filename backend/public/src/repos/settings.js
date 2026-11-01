// Configuración clave/valor (payment_methods, company, credit_note_months).
// MIGRADO A "TODO ONLINE": vive en el backend (tabla settings), compartido entre
// todas las PC. Antes era el store local "config" de IndexedDB.

import { api } from '../core/api.js';

let _cache = null;

async function loadAll(force = false) {
  if (_cache && !force) return _cache;
  try {
    _cache = (await api('/api/settings')) || {};
  } catch {
    _cache = _cache || {};
  }
  return _cache;
}

// Devuelve el VALOR de una clave (no el registro). fallback si no existe.
export async function getConfig(key, fallback = null) {
  const all = await loadAll();
  return all && all[key] != null ? all[key] : fallback;
}

export async function setConfig(key, value) {
  await api(`/api/settings/${encodeURIComponent(key)}`, { method: 'PUT', body: { value } });
  if (!_cache) _cache = {};
  _cache[key] = value;
  return value;
}

export function invalidate() { _cache = null; }

// Promos vigentes para el POS: las ACTIVAS del mes actual; si el mes no tiene, cae al mes
// anterior. Van ATADAS a una forma de pago (method_id): en el cobro se elige el medio base
// (payment_methods) y, si tiene promos, la promo. No filtra por día/fecha (el cajero elige
// la que corresponde); la vigencia queda registrada para el reporte. Si no hay promos,
// devuelve [] (el POS igual muestra las formas de pago base).
export async function getActivePromos() {
  const now = new Date();
  const mk = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const pm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prev = `${pm.getFullYear()}-${String(pm.getMonth() + 1).padStart(2, '0')}`;
  const promos = (await getConfig('promos', {})) || {};
  const active = (list) => (list || []).filter((p) => p.active !== false);
  let list = active(promos[mk]);
  if (!list.length) list = active(promos[prev]);
  return list.map((p) => ({
    id: p.id, name: p.name, method_id: p.method_id || null, icon: p.icon || 'credit_card',
    bank: p.bank, card_type: p.card_type, acquirer_id: p.acquirer_id, installments: p.installments,
    discount_pct: p.discount_pct, discount_funder: p.discount_funder, tope_amount: p.tope_amount, tope_mode: p.tope_mode,
  }));
}
