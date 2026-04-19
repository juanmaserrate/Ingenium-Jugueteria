// Event bus simple para comunicación entre módulos.
// También soporta BroadcastChannel para sincronizar entre pestañas.

const listeners = new Map();
const bc = ('BroadcastChannel' in window) ? new BroadcastChannel('ingenium') : null;

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}

export function emit(event, payload) {
  const set = listeners.get(event);
  if (set) for (const fn of set) { try { fn(payload); } catch (e) { console.error(e); } }
  if (bc) bc.postMessage({ event, payload });
}

if (bc) {
  bc.onmessage = (ev) => {
    const { event, payload } = ev.data || {};
    const set = listeners.get(event);
    if (set) for (const fn of set) { try { fn(payload, { remote: true }); } catch (e) { console.error(e); } }
  };
}

// Eventos estándar (strings constantes para evitar typos)
export const EV = {
  SALE_CONFIRMED: 'sale:confirmed',
  RETURN_CONFIRMED: 'return:confirmed',
  CASH_MOVED: 'cash:moved',
  PRODUCT_UPDATED: 'product:updated',
  STOCK_CHANGED: 'stock:changed',
  NOTIFICATION_NEW: 'notification:new',
  AUDIT_LOGGED: 'audit:logged',
  BRANCH_CHANGED: 'branch:changed',
  // Integración Tienda Nube
  TN_CONNECTED: 'tn:connected',
  TN_DISCONNECTED: 'tn:disconnected',
  TN_ORDER_RECEIVED: 'tn:order_received',
  TN_PRODUCT_PENDING: 'tn:product_pending',
  SYNC_QUEUE_UPDATED: 'sync:queue_updated',
  SYNC_CONFLICT: 'sync:conflict',
};
