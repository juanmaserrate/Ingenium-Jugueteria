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
