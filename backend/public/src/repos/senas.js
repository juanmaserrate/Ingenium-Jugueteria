// Señas (reservas con anticipo). Backend: /api/senas.
import { api } from '../core/api.js';

// status: 'active' | 'redeemed' | 'cancelled' | '' (todas). customerId/branchId opcionales.
export function list(customerId, status = 'active', branchId = '') {
  const q = new URLSearchParams();
  if (customerId) q.set('customerId', customerId);
  if (status) q.set('status', status);
  if (branchId) q.set('branchId', branchId);
  return api(`/api/senas?${q.toString()}`);
}
export function byNumber(n) { return api(`/api/senas/by-number/${encodeURIComponent(n)}`); }
export function create(body) { return api('/api/senas', { method: 'POST', body }); }
// refund: { methodId, methodName, affectsCash, branchId } = cómo se le devuelve la plata.
export function cancel(id, refund = null) {
  return api(`/api/senas/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: { refund } });
}
