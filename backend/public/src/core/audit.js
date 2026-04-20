// Registro de auditoría. Cada operación relevante pasa por aquí.
// S-4: cadena de hashes (tipo blockchain) para detección de tampering.
// C-7: AUDIT_ACTIONS centralizadas como constantes.

import { put, getAll, get, newId } from './db.js';
import { currentSession } from './auth.js';
import { emit, EV } from './events.js';

// C-7: Acciones y entidades canónicas. Preferir usar estas constantes a strings sueltos.
export const AUDIT_ACTIONS = Object.freeze({
  CREATE:        'create',
  UPDATE:        'update',
  DELETE:        'delete',
  CONFIRM:       'confirm',
  CANCEL:        'cancel',
  LOGIN:         'login',
  LOGOUT:        'logout',
  TRANSFER:      'transfer',
  STOCK_ADJUST:  'stock_adjust',
  CASH_OPEN:     'cash_open',
  CASH_CLOSE:    'cash_close',
  CASH_MOVE:     'cash_move',
  RETURN:        'return',
  CHECK_STATUS:  'check_status',
  BACKUP_EXPORT: 'backup_export',
  BACKUP_IMPORT: 'backup_import',
  SEED:          'seed',
  RESET:         'reset',
});

export const AUDIT_ENTITIES = Object.freeze({
  PRODUCT:    'producto',
  SALE:       'venta',
  RETURN:     'devolucion',
  CASH:       'caja',
  STOCK:      'stock',
  CHECK:      'cheque',
  CUSTOMER:   'cliente',
  EMPLOYEE:   'empleado',
  TRANSFER:   'transferencia',
  SESSION:    'session',
  SETTINGS:   'settings',
  TASK:       'tarea',
  CALENDAR:   'evento',
});

// Hash SHA-256 hex (vía WebCrypto).
async function sha256Hex(s) {
  const buf = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Hash canónico: orden determinista de campos + prev_hash.
async function computeHash(entry) {
  const payload = JSON.stringify({
    id: entry.id,
    datetime: entry.datetime,
    user_id: entry.user_id,
    branch_id: entry.branch_id,
    action: entry.action,
    entity: entry.entity,
    entity_id: entry.entity_id,
    description: entry.description,
    before: entry.before,
    after: entry.after,
    prev_hash: entry.prev_hash,
  });
  return sha256Hex(payload);
}

async function lastHash() {
  try {
    const all = await getAll('audit_log');
    if (!all.length) return '0000000000000000000000000000000000000000000000000000000000000000';
    const sorted = all.sort((a, b) => (a.datetime || '').localeCompare(b.datetime || ''));
    return sorted[sorted.length - 1].hash || '0000000000000000000000000000000000000000000000000000000000000000';
  } catch { return '0000000000000000000000000000000000000000000000000000000000000000'; }
}

export async function log({ action, entity, entity_id, before = null, after = null, description = '' }) {
  const s = currentSession();
  const prev = await lastHash();
  const entry = {
    id: newId('aud'),
    datetime: new Date().toISOString(),
    user_id: s?.user_id || null,
    user_name: s?.user_name || 'sistema',
    branch_id: s?.branch_id || null,
    action,
    entity,
    entity_id: entity_id ?? null,
    description,
    before,
    after,
    prev_hash: prev,
  };
  entry.hash = await computeHash(entry);
  await put('audit_log', entry);
  emit(EV.AUDIT_LOGGED, entry);
  return entry;
}

export async function list({ userId, entity, since, until } = {}) {
  const all = await getAll('audit_log');
  return all.filter(e => {
    if (userId && e.user_id !== userId) return false;
    if (entity && e.entity !== entity) return false;
    if (since && e.datetime < since) return false;
    if (until && e.datetime > until) return false;
    return true;
  }).sort((a, b) => b.datetime.localeCompare(a.datetime));
}

// S-4: verificación de cadena. Recorre en orden y re-computa el hash esperado.
// Devuelve { ok, brokenAt, total } para mostrar en Configuración.
export async function verifyChain() {
  const all = (await getAll('audit_log')).sort((a, b) => (a.datetime || '').localeCompare(b.datetime || ''));
  let prev = '0000000000000000000000000000000000000000000000000000000000000000';
  for (let i = 0; i < all.length; i++) {
    const e = all[i];
    if (!e.hash || !e.prev_hash) continue; // entradas anteriores a S-4: saltear
    if (e.prev_hash !== prev) return { ok: false, brokenAt: i, entry: e, total: all.length, reason: 'prev_hash mismatch' };
    const expected = await computeHash({ ...e, hash: undefined });
    if (expected !== e.hash) return { ok: false, brokenAt: i, entry: e, total: all.length, reason: 'hash mismatch' };
    prev = e.hash;
  }
  return { ok: true, total: all.length };
}
