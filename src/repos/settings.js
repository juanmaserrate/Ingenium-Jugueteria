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

// Promos activas para el POS. Van ATADAS a una forma de pago (method_id): en el cobro se
// elige el medio base (payment_methods) y, si tiene promos, la promo. Es un array plano
// (modelo "todo dentro del medio"); tolera el shape viejo { "YYYY-MM": [...] }. El costo lo
// calcula el backend desde la forma de pago; acá solo mandamos lo que el POS necesita para
// el selector y la leyenda (descuento + tope). Si no hay promos, devuelve [].
export async function getActivePromos() {
  const raw = (await getConfig('promos', [])) || [];
  const list = Array.isArray(raw) ? raw : Object.values(raw).flat();
  return list.filter((p) => p && p.active !== false).map((p) => ({
    id: p.id, name: p.name, method_id: p.method_id || null, icon: p.icon || 'credit_card',
    installments: p.installments, discount_pct: p.discount_pct, tope_amount: p.tope_amount,
  }));
}
