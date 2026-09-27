// Señas (reservas con anticipo). Backend: /api/senas.
import { api } from '../core/api.js';

export function list(customerId, status = 'active') {
  const q = new URLSearchParams();
  if (customerId) q.set('customerId', customerId);
  if (status) q.set('status', status);
  return api(`/api/senas?${q.toString()}`);
}
export function byNumber(n) { return api(`/api/senas/by-number/${encodeURIComponent(n)}`); }
export function create(body) { return api('/api/senas', { method: 'POST', body }); }
export function cancel(id) { return api(`/api/senas/${encodeURIComponent(id)}/cancel`, { method: 'POST' }); }
