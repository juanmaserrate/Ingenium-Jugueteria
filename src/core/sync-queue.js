// Cola local de operaciones cr\u00edticas (ventas, devoluciones) pendientes de sync
// con el backend. Persiste en IndexedDB (store "sync_queue").
//
// Uso:
//   enqueueOperation({ type: 'sale', payload })  → se intenta subir ya
//   flushQueue()                                  → se llama al recuperar internet
//
// Las ventas se env\u00edan a /api/sales/batch. Si hay conflicto, se crea un registro
// en sync_conflicts del backend y el usuario lo resuelve manualmente.

import { get as dbGet, put as dbPut, del as dbDel, getAll as dbAll } from './db.js';
import { api, ApiError } from './api.js';
import { toast } from './notifications.js';
import { emit, EV } from './events.js';

const STORE = 'sync_queue_local';

let flushing = false;

export async function enqueueOperation(op) {
  const item = {
    id: op.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: op.type,           // 'sale' | 'return' | 'stock_adjust'
    payload: op.payload,
    attempts: 0,
    createdAt: new Date().toISOString(),
  };
  await dbPut(STORE, item);
  emit(EV.SYNC_QUEUE_UPDATED);
  // Intentar flush inmediato (si hay internet funciona, si no queda en cola)
  flushQueue().catch(() => null);
  return item;
}

export async function listQueue() {
  try {
    return await dbAll(STORE);
  } catch {
    return [];
  }
}

export async function flushQueue() {
  if (flushing) return;
  flushing = true;
  try {
    const items = await listQueue();
    if (items.length === 0) return;

    // Agrupar ventas en un batch
    const sales = items.filter((i) => i.type === 'sale');
    if (sales.length > 0) {
      try {
        const body = sales.map((s) => ({ ...s.payload, offlineId: s.id }));
        const { results } = await api('/api/sales/batch', { method: 'POST', body });
        for (const r of results) {
          const local = sales.find((s) => s.id === r.offlineId);
          if (!local) continue;
          if (r.ok) {
            await dbDel(STORE, local.id);
          } else {
            // Conflicto: marcar y notificar (no eliminar)
            local.attempts = (local.attempts ?? 0) + 1;
            local.lastError = r.error;
            local.conflict = true;
            await dbPut(STORE, local);
          }
        }
        if (results.some((r) => !r.ok)) {
          toast('Hay ventas con conflicto al sincronizar. Revisar pantalla de conflictos.', 'warning');
        } else {
          toast('Ventas offline sincronizadas', 'success');
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 0) {
          // Sigue offline, reintentar despu\u00e9s
        } else {
          console.error('Flush sales failed', err);
        }
      }
    }

    // Otros tipos (return, stock_adjust) — uno por uno
    const others = items.filter((i) => i.type !== 'sale');
    for (const item of others) {
      try {
        if (item.type === 'return') {
          await api('/api/returns', { method: 'POST', body: item.payload });
        } else if (item.type === 'stock_adjust') {
          await api('/api/stock/adjust', { method: 'POST', body: item.payload });
        }
        await dbDel(STORE, item.id);
      } catch (err) {
        if (err instanceof ApiError && err.status === 0) break;
        item.attempts = (item.attempts ?? 0) + 1;
        item.lastError = err.message;
        await dbPut(STORE, item);
      }
    }

    emit(EV.SYNC_QUEUE_UPDATED);
  } finally {
    flushing = false;
  }
}

// Auto-flush cuando vuelve la conexi\u00f3n
window.addEventListener('online', () => {
  toast('Conexi\u00f3n recuperada, sincronizando...', 'info');
  flushQueue();
});

// Reintento peri\u00f3dico (cada 30s si hay items en cola)
setInterval(() => {
  if (navigator.onLine) flushQueue();
}, 30_000);
