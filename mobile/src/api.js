import { API_BASE } from './config';

async function req(path, { method = 'GET', token, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* sin cuerpo */ }
  if (!res.ok) {
    const msg = (data && (data.message || data.error)) || `Error ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

// --- Auth ---
export const getBranches = () => req('/auth/branches');
export const getBranchUsers = (branchId) => req(`/auth/branches/${encodeURIComponent(branchId)}/users`);
export const loginPin = ({ branchId, userId, pin }) =>
  req('/auth/login-pin', { method: 'POST', body: { branchId, userId, pin } });

// --- Panel ---
// branchId undefined = consolidado (todas las sucursales). Sólo el admin ve otras sucursales.
export const getDashboard = (token, branchId) =>
  req(`/api/metrics/dashboard${branchId ? `?branchId=${encodeURIComponent(branchId)}` : ''}`, { token });

// Ventas confirmadas de HOY (con sus ítems), opcionalmente de una sucursal.
export const getSalesToday = (token, branchId) => {
  const today = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10); // día en AR (UTC-3)
  const qs = new URLSearchParams({ status: 'confirmed', from: `${today}T00:00:00`, to: `${today}T23:59:59`, limit: '300' });
  if (branchId) qs.set('branchId', branchId);
  return req(`/api/sales?${qs.toString()}`, { token });
};

// --- Push ---
export const registerPush = (token, pushToken) =>
  req('/api/push/register', { method: 'POST', token, body: { token: pushToken, platform: 'android' } });
