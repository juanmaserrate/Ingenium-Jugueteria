// Almacén genérico clave/valor en el backend (tabla kv_items). Reemplaza los
// stores locales de IndexedDB que faltaban migrar: cheques, tareas, calendario,
// notificaciones, costos del P&L. Guarda el objeto completo por su id.

import { api } from '../core/api.js';
import { getAll as idbGetAll, del as idbDel } from '../core/db.js';

const keyOf = (v) => v?.id ?? v?.key ?? v?.name;

export async function list(collection) {
  return (await api(`/api/kv/${encodeURIComponent(collection)}`)) || [];
}
export async function get(collection, key) {
  return api(`/api/kv/${encodeURIComponent(collection)}/${encodeURIComponent(key)}`);
}
export async function put(collection, value) {
  const key = keyOf(value);
  if (key == null) throw new Error('El objeto no tiene id/key');
  await api(`/api/kv/${encodeURIComponent(collection)}/${encodeURIComponent(key)}`, { method: 'PUT', body: { value } });
  return value;
}
export async function del(collection, key) {
  return api(`/api/kv/${encodeURIComponent(collection)}/${encodeURIComponent(key)}`, { method: 'DELETE' });
}

// Sube al servidor los items que quedaron en la base local del navegador y los
// borra de local. Devuelve cuántos importó.
export async function migrateFromLocal(collection) {
  const local = (await idbGetAll(collection).catch(() => [])) || [];
  let n = 0;
  for (const v of local) {
    const key = keyOf(v);
    if (key == null) continue;
    try { await put(collection, v); await idbDel(collection, key); n++; } catch { /* seguir */ }
  }
  return n;
}
