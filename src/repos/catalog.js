// Catálogo (categorías, marcas, proveedores, subcategorías) BACKEND-FIRST con cache local.
// El servidor (Postgres) es la fuente de verdad; cada PC cachea el catálogo en IndexedDB.
// - list()/get(): leen del cache IndexedDB → rápido y funciona OFFLINE (no se tocan los consumidores).
// - save()/remove(): escriben al backend y refrescan el cache. Requieren conexión (acción administrativa).
// - syncCatalog(): baja el catálogo del backend al cache; se llama al iniciar la app.

import { put, del, getAll, newId, get } from '../core/db.js';
import { api, ApiError } from '../core/api.js';
import { toast } from '../core/notifications.js';

// store IndexedDB ↔ path del endpoint REST ↔ prefijo de id local
const mk = (store, entityLabel, apiPath, idPrefix) => ({
  // Lectura: siempre del cache local (offline-safe). Los consumidores no cambian.
  list: () => getAll(store),
  get: (id) => get(store, id),

  async save(data) {
    const isNew = !data.id;
    const rec = { ...data, id: data.id || newId(idPrefix) };
    try {
      const method = isNew ? 'POST' : 'PUT';
      const path = isNew ? `/api/${apiPath}` : `/api/${apiPath}/${encodeURIComponent(rec.id)}`;
      // El backend devuelve el registro persistido (snake/camel según Prisma); cacheamos lo que mandamos
      // más el id confirmado para mantener el shape que ya usan los módulos del front.
      const saved = await api(path, { method, body: rec });
      const cached = { ...rec, id: saved?.id || rec.id };
      await put(store, cached);
      return cached;
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) {
        toast('Necesitás conexión para editar el catálogo', 'warn');
      } else {
        toast(`No se pudo guardar: ${e.message}`, 'error');
      }
      throw e;
    }
  },

  async remove(id) {
    try {
      await api(`/api/${apiPath}/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await del(store, id);
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) {
        toast('Necesitás conexión para eliminar del catálogo', 'warn');
      } else {
        toast(`No se pudo eliminar: ${e.message}`, 'error');
      }
      throw e;
    }
  },

  // Internos para el sync
  _store: store,
  _apiPath: apiPath,
});

export const Categories    = mk('categories',    'categoria',    'categories',    'cat');
export const Subcategories = mk('subcategories', 'subcategoria', 'subcategories', 'sub');
export const Brands        = mk('brands',        'marca',        'brands',        'mrc');
export const Suppliers     = mk('suppliers',     'proveedor',    'suppliers',     'sup');

const ALL = [Categories, Subcategories, Brands, Suppliers];
const CATALOG_KEYS = { categories: 'categories', subcategories: 'subcategories', brands: 'brands', suppliers: 'suppliers' };

/**
 * Sincroniza el catálogo del backend al cache IndexedDB. Se llama al iniciar la app.
 * No bloqueante: si el backend no responde, queda el cache actual (offline-safe).
 *
 * Migración one-shot (flag localStorage 'catalog_synced_v1'): la primera vez, si esta PC
 * ya tenía catálogo local que no está en el backend, lo SUBE antes de bajar (no perder datos).
 * Con el flag puesto, solo baja (el backend manda → no resucita borrados).
 */
export async function syncCatalog() {
  const FLAG = 'catalog_synced_v1';
  const firstTime = !localStorage.getItem(FLAG);
  let remote;
  try {
    remote = await api('/api/catalog');
  } catch {
    return false; // offline u error → seguimos con el cache existente
  }

  // Migración inicial: subir lo local que no esté en el backend.
  if (firstTime) {
    try {
      for (const repo of ALL) {
        const localItems = await getAll(repo._store);
        if (!localItems.length) continue;
        const remoteIds = new Set((remote[storeToKey(repo._store)] || []).map((x) => x.id));
        for (const it of localItems) {
          if (!it?.id || remoteIds.has(it.id)) continue;
          try { await api(`/api/${repo._apiPath}`, { method: 'POST', body: it }); } catch { /* best-effort */ }
        }
      }
      // Re-bajar para incluir lo recién subido.
      remote = await api('/api/catalog');
    } catch { /* si falla el push, igual bajamos lo que haya */ }
    localStorage.setItem(FLAG, '1');
  }

  // Bajar: reemplazar el cache de cada store con lo del backend.
  for (const [storeName, key] of Object.entries(CATALOG_KEYS)) {
    const items = remote[key] || [];
    // Limpiamos y reescribimos para reflejar borrados hechos en otras PCs.
    const current = await getAll(storeName);
    const remoteIds = new Set(items.map((x) => x.id));
    for (const c of current) {
      if (!remoteIds.has(c.id)) await del(storeName, c.id);
    }
    for (const it of items) await put(storeName, it);
  }
  return true;
}

function storeToKey(store) {
  return CATALOG_KEYS[store] || store;
}
