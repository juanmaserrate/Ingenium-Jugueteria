// Wrapper minimalista sobre IndexedDB.
// Expone: open(), tx(), get/put/del/getAll, y queries por índice.
// Pensado para que los repositorios sean triviales.

import { DB_NAME, DB_VERSION, STORES } from './schema.js';

let _db = null;

export async function openDB() {
  if (_db) return _db;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      for (const def of STORES) {
        if (!db.objectStoreNames.contains(def.name)) {
          const store = db.createObjectStore(def.name, { keyPath: def.keyPath });
          for (const idx of (def.indexes || [])) {
            const [idxName, keyPath, opts = {}] = idx;
            store.createIndex(idxName, keyPath, opts);
          }
        }
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

// Helper para promisificar un IDBRequest
function p(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function get(store, key) {
  const db = await openDB();
  return p(db.transaction(store, 'readonly').objectStore(store).get(key));
}

export async function getAll(store) {
  const db = await openDB();
  return p(db.transaction(store, 'readonly').objectStore(store).getAll());
}

export async function put(store, value) {
  const db = await openDB();
  return p(db.transaction(store, 'readwrite').objectStore(store).put(value));
}

export async function del(store, key) {
  const db = await openDB();
  return p(db.transaction(store, 'readwrite').objectStore(store).delete(key));
}

export async function clear(store) {
  const db = await openDB();
  return p(db.transaction(store, 'readwrite').objectStore(store).clear());
}

export async function count(store) {
  const db = await openDB();
  return p(db.transaction(store, 'readonly').objectStore(store).count());
}

// Query por índice. matcher puede ser valor exacto o IDBKeyRange.
export async function getByIndex(store, indexName, matcher) {
  const db = await openDB();
  const idx = db.transaction(store, 'readonly').objectStore(store).index(indexName);
  return p(idx.getAll(matcher));
}

// Transacción multi-store (para operaciones atómicas: venta + stock + caja + audit)
export async function tx(stores, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const api = {};
    for (const s of stores) api[s] = t.objectStore(s);
    let result;
    Promise.resolve(fn(api))
      .then(r => { result = r; })
      .catch(err => { try { t.abort(); } catch {} reject(err); });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction aborted'));
  });
}

// Reset total de la DB (útil para "reset demo" en Config).
export async function destroyDB() {
  if (_db) { _db.close(); _db = null; }
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve(); // se va a borrar cuando se cierre la pestaña
  });
}

// ID generator (timestamp + random) — suficiente para local, Postgres usará su propio id.
export function newId(prefix = '') {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return prefix ? `${prefix}_${t}${r}` : `${t}${r}`;
}

// Stock composite key
export const stockId = (productId, branchId) => `${productId}|${branchId}`;
