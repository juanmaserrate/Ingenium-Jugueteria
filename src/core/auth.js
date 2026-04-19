// Sesión local guardada en sessionStorage.
// Fase 1: PIN numérico (demo). Fase 2: JWT.

import { get, getAll, put } from './db.js';
import { verifyPin, derivePin } from './crypto.js';

const SESSION_KEY = 'ingenium_session';
const LAST_ACTIVITY_KEY = 'ingenium_last_activity';

// Timeout por inactividad (ms). Configurable más adelante desde Settings.
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;   // 30 min
export const IDLE_WARN_MS    = 2 * 60 * 1000;    // avisar 2 min antes

export function currentSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    // Expirada por inactividad → limpiar y devolver null
    const last = Number(sessionStorage.getItem(LAST_ACTIVITY_KEY)) || 0;
    if (last && Date.now() - last > IDLE_TIMEOUT_MS) {
      sessionStorage.removeItem(SESSION_KEY);
      sessionStorage.removeItem(LAST_ACTIVITY_KEY);
      return null;
    }
    return s;
  } catch { return null; }
}

export function isLoggedIn() {
  return !!currentSession();
}

// Bump timestamp de última actividad (llamado por el watcher en app.html).
export function touchActivity() {
  sessionStorage.setItem(LAST_ACTIVITY_KEY, String(Date.now()));
}

// Info de expiración para el watcher: ms restantes hasta logout automático.
export function millisUntilExpiry() {
  const last = Number(sessionStorage.getItem(LAST_ACTIVITY_KEY)) || 0;
  if (!last) return IDLE_TIMEOUT_MS;
  return Math.max(0, IDLE_TIMEOUT_MS - (Date.now() - last));
}

export async function login(branchId, userId, pin) {
  const user = await get('users', userId);
  if (!user) throw new Error('Usuario no encontrado');
  if (user.branch_id !== branchId) throw new Error('Usuario no pertenece a la sucursal');
  // Camino nuevo: hash PBKDF2. Migración: si sólo tiene `pin` plano, validar y upgradear.
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
    branch_id: branch.id,
    branch_name: branch.name,
    login_at: new Date().toISOString(),
  };
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  touchActivity();
  return session;
}

export function logout(reason = 'manual') {
  sessionStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(LAST_ACTIVITY_KEY);
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
  const explicit = sessionStorage.getItem(ACTIVE_BRANCH_KEY);
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
  sessionStorage.setItem(ACTIVE_BRANCH_KEY, branchId);
  return b;
}

export async function listBranches() { return getAll('branches'); }
export async function listUsersForBranch(branchId) {
  const all = await getAll('users');
  return all.filter(u => u.branch_id === branchId);
}
