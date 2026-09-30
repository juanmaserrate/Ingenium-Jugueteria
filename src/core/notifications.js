// Notificaciones in-app (campana).

import { newId } from './db.js';
import * as Kv from '../repos/kv.js';
import { emit, EV } from './events.js';
import { currentSession } from './auth.js';

// Notificaciones persistentes: ahora en el servidor (compartidas entre PC).
export async function push({ title, body = '', type = 'info', link = null, branch_id = null }) {
  const s = currentSession();
  const notif = {
    id: newId('ntf'),
    datetime: new Date().toISOString(),
    user_id: s?.user_id || null,
    branch_id: branch_id ?? s?.branch_id ?? null,
    type,          // info | warn | success | error
    title,
    body,
    link,
    read_at: null,
  };
  try { await Kv.put('notifications', notif); } catch { /* no bloquear el flujo si falla */ }
  emit(EV.NOTIFICATION_NEW, notif);
  return notif;
}

export async function listAll({ onlyUnread = false } = {}) {
  const all = (await Kv.list('notifications').catch(() => [])) || [];
  const filt = onlyUnread ? all.filter(n => !n.read_at) : all;
  return filt.sort((a, b) => String(b.datetime).localeCompare(String(a.datetime)));
}

export async function markRead(id) {
  const all = (await Kv.list('notifications').catch(() => [])) || [];
  const n = all.find(x => x.id === id);
  if (!n) return;
  n.read_at = new Date().toISOString();
  try { await Kv.put('notifications', n); } catch { /* noop */ }
  emit(EV.NOTIFICATION_NEW, n);
}

export async function markAllRead() {
  const all = (await Kv.list('notifications').catch(() => [])) || [];
  const now = new Date().toISOString();
  for (const n of all) {
    if (!n.read_at) { n.read_at = now; try { await Kv.put('notifications', n); } catch { /* noop */ } }
  }
  emit(EV.NOTIFICATION_NEW, null);
}

// Toast (UI transitorio).
// U-8: soporta { action: { label, onClick, timeoutMs } } para "deshacer".
export function toast(message, kind = 'info', opts = {}) {
  let c = document.getElementById('toast-container');
  if (!c) { c = document.createElement('div'); c.id = 'toast-container'; document.body.appendChild(c); }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  const icons = { success: 'check_circle', error: 'error', warn: 'warning', info: 'info' };
  const actionHTML = opts.action
    ? `<button type="button" class="toast-action ml-2 px-3 py-1 rounded-full bg-[#d82f1e] text-white text-xs font-black hover:brightness-110">${opts.action.label || 'Deshacer'}</button>`
    : '';
  // Escapamos el mensaje: a veces incluye datos del servidor o de TN (nombres, errores)
  // y el toast se pinta con innerHTML. Ningún llamador pasa HTML a propósito.
  const safeMessage = String(message ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  el.innerHTML = `
    <span class="material-symbols-outlined text-[#d82f1e]">${icons[kind] || 'info'}</span>
    <div class="flex-1 text-sm font-medium text-secondary">${safeMessage}</div>
    ${actionHTML}
  `;
  c.appendChild(el);
  const ttl = opts.action?.timeoutMs ?? 3200;
  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return; dismissed = true;
    el.style.opacity = '0'; el.style.transform = 'translateX(20px)';
    setTimeout(() => el.remove(), 400);
  };
  if (opts.action) {
    const btn = el.querySelector('.toast-action');
    btn.addEventListener('click', async () => {
      try { await opts.action.onClick?.(); } catch (e) { console.error(e); }
      dismiss();
    });
  }
  setTimeout(dismiss, ttl);
  return { dismiss };
}
