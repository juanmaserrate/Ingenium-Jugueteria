// Sesión local persistente (localStorage): el usuario queda logueado aunque
// cierre la pestaña o el navegador, hasta que salga manualmente.
// Fase 1: PIN numérico (demo). Fase 2: JWT.

import { get, getAll, put } from './db.js';
import { verifyPin, derivePin } from './crypto.js';
import { getApiBase, setToken } from './api.js';

const SESSION_KEY = 'ingenium_session';
const LAST_ACTIVITY_KEY = 'ingenium_last_activity';

// Sesión persistente: se mantiene logueado por un período largo. Se cierra sólo
// manualmente (botón Salir) o tras una inactividad muy prolongada.
export const IDLE_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000;  // 30 días
export const IDLE_WARN_MS    = 2 * 60 * 1000;             // avisar 2 min antes

export function currentSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    // Expirada por inactividad → limpiar y devolver null
    const last = Number(localStorage.getItem(LAST_ACTIVITY_KEY)) || 0;
    if (last && Date.now() - last > IDLE_TIMEOUT_MS) {
      localStorage.removeItem(SESSION_KEY);
      localStorage.removeItem(LAST_ACTIVITY_KEY);
      return null;
    }
    return s;
  } catch { return null; }
}

export function isLoggedIn() {
  return !!currentSession();
}

// Rol de la sesión actual. 'manager' (legacy) se trata igual que 'encargado'.
export function currentRole() { return currentSession()?.role || null; }
export function isAdmin() { return currentRole() === 'admin'; }
export function isEncargado() { const r = currentRole(); return r === 'encargado' || r === 'manager'; }

// Bump timestamp de última actividad (llamado por el watcher en app.html).
export function touchActivity() {
  localStorage.setItem(LAST_ACTIVITY_KEY, String(Date.now()));
}

// Info de expiración para el watcher: ms restantes hasta logout automático.
export function millisUntilExpiry() {
  const last = Number(localStorage.getItem(LAST_ACTIVITY_KEY)) || 0;
  if (!last) return IDLE_TIMEOUT_MS;
  return Math.max(0, IDLE_TIMEOUT_MS - (Date.now() - last));
}

export async function login(branchId, userId, pin) {
  // TODO ONLINE: el backend es autoritativo (valida el PIN y entrega el JWT).
  // Solo si el backend está inalcanzable (offline) se cae al login local.
  let data = null, unauthorized = false, reachable = true;
  try {
    const res = await fetch(`${getApiBase()}/auth/login-pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branchId, userId, pin: String(pin) }),
    });
    if (res.ok) data = await res.json();
    else if (res.status === 401) unauthorized = true;
    else reachable = false; // 5xx u otro → intentar local
  } catch {
    reachable = false; // error de red → offline
  }

  if (unauthorized) throw new Error('Usuario, sucursal o PIN incorrectos');

  if (data?.token && data?.user) {
    setToken(data.token);
    const branches = await listBranches().catch(() => []);
    const branch = (branches || []).find(b => b.id === branchId);
    const session = {
      user_id: data.user.id,
      user_name: `${data.user.name} ${data.user.lastname || ''}`.trim(),
      role: data.user.role,
      branch_id: branchId,
      branch_name: branch?.name || branchId,
      login_at: new Date().toISOString(),
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    touchActivity();
    return session;
  }

  // Fallback LOCAL (backend inalcanzable). Sin token: los módulos online avisarán.
  if (reachable) throw new Error('No se pudo iniciar sesión. Reintentá.');
  return loginLocal(branchId, userId, pin);
}

// Validación local contra IndexedDB (solo fallback offline).
async function loginLocal(branchId, userId, pin) {
  const user = await get('users', userId);
  if (!user) throw new Error('Sin conexión y el usuario no está en esta PC');
  if (user.branch_id !== branchId) throw new Error('Usuario no pertenece a la sucursal');
  if (user.pin_hash && user.pin_salt) {
    const ok = await verifyPin(String(pin), user.pin_salt, user.pin_hash, user.pin_iters);
    if (!ok) throw new Error('PIN incorrecto');
  } else if (user.pin != null) {
    if (String(user.pin) !== String(pin)) throw new Error('PIN incorrecto');
    const derived = await derivePin(String(pin));
    Object.assign(user, derived);
    delete user.pin;
    await put('users', user);
  } else {
    throw new Error('Usuario sin PIN configurado');
  }
  const branch = await get('branches', branchId);
  const session = {
    user_id: user.id,
    user_name: `${user.name} ${user.lastname || ''}`.trim(),
    role: user.role,
    branch_id: branchId,
    branch_name: branch?.name || branchId,
    login_at: new Date().toISOString(),
  };
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  touchActivity();
  setToken(null);
  return session;
}

export function logout(reason = 'manual') {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(LAST_ACTIVITY_KEY);
  try { sessionStorage.removeItem('panel_unlocked'); } catch {}
  setToken(null);
  if (reason === 'idle') {
    location.href = './index.html?expired=1';
  } else {
    location.href = './index.html';
  }
}

export function requireAuth() {
  if (!isLoggedIn()) {
    location.href = './index.html';
    throw new Error('Redirecting to login');
  }
  return currentSession();
}

// Sucursal "activa" desde el topbar (un admin puede cambiar sin relogear).
// Por defecto, la sucursal del usuario logueado.
const ACTIVE_BRANCH_KEY = 'ingenium_active_branch';
export function activeBranchId() {
  const explicit = localStorage.getItem(ACTIVE_BRANCH_KEY);
  if (explicit) return explicit;
  return currentSession()?.branch_id;
}
export async function setActiveBranch(branchId) {
  if (!branchId) throw new Error('Sucursal inválida');
  const b = await get('branches', branchId);
  if (!b) throw new Error('Sucursal no encontrada');
  const session = currentSession();
  // Un admin puede cambiar; otros roles quedan ceñidos a su sucursal asignada
  if (session && session.role !== 'admin' && session.branch_id !== branchId) {
    throw new Error('No tenés permiso para cambiar de sucursal');
  }
  localStorage.setItem(ACTIVE_BRANCH_KEY, branchId);
  return b;
}

export async function listBranches() {
  // Backend primero (para que las sucursales sean iguales en todas las PC).
  try {
    const res = await fetch(`${getApiBase()}/auth/branches`);
    if (res.ok) { const b = await res.json(); if (Array.isArray(b) && b.length) return b; }
  } catch { /* offline → local */ }
  return getAll('branches');
}
export async function listUsersForBranch(branchId) {
  // Backend primero: así los usuarios creados en cualquier PC aparecen en el login.
  try {
    const res = await fetch(`${getApiBase()}/auth/branches/${encodeURIComponent(branchId)}/users`);
    if (res.ok) { const u = await res.json(); if (Array.isArray(u)) return u.map(x => ({ ...x, branch_id: branchId })); }
  } catch { /* offline → local */ }
  const all = await getAll('users');
  return all.filter(u => u.branch_id === branchId);
}
