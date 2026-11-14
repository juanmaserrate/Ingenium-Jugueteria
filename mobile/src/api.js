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
// IMPORTANTE: los límites del día se mandan CON offset de Argentina (-03:00) para
// que el backend tome exactamente el mismo rango que el panel (00:00 a 24:00 AR).
// Sin el offset, new Date() del servidor (UTC) corría la ventana 3 hs y los totales
// no coincidían con las tarjetas del panel.
export const getSalesToday = (token, branchId) => {
  const arNow = new Date(Date.now() - 3 * 3600 * 1000);
  const today = arNow.toISOString().slice(0, 10);                               // hoy en AR
  const tomorrow = new Date(arNow.getTime() + 24 * 3600 * 1000).toISOString().slice(0, 10); // mañana en AR
  const qs = new URLSearchParams({
    status: 'confirmed',
    from: `${today}T00:00:00.000-03:00`,
    to: `${tomorrow}T00:00:00.000-03:00`, // exclusivo (lt), = fin del día AR
    limit: '300',
  });
  if (branchId) qs.set('branchId', branchId);
  return req(`/api/sales?${qs.toString()}`, { token });
};

// Series de ventas por día (30) y por mes (12), opcionalmente de una sucursal.
export const getSeries = (token, branchId) => {
  const today = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  const qs = new URLSearchParams({ today, days: '30', months: '12' });
  if (branchId) qs.set('branchId', branchId);
  return req(`/api/metrics/series?${qs.toString()}`, { token });
};

// --- Push ---
export const registerPush = (token, pushToken) =>
  req('/api/push/register', { method: 'POST', token, body: { token: pushToken, platform: 'android' } });
