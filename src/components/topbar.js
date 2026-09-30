// Topbar: título del módulo activo, selector sucursal, bell, avatar.

import * as Auth from '../core/auth.js';
import * as Notif from '../core/notifications.js';
import * as Cash from '../repos/cash.js';
import * as Products from '../repos/products.js';
import * as Settings from '../repos/settings.js';
import { syncCatalog } from '../repos/catalog.js';
import { navigate } from '../core/router.js';
import { api } from '../core/api.js';
import { on, EV, emit } from '../core/events.js';

// Logo: osito de peluche (no existe glifo en la fuente, así que va como SVG a medida).
// Osito blanco con ojos/nariz en el rojo de la marca; se dibuja dentro del círculo rojo.
const TEDDY_SVG = `<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
  <g fill="#ffffff">
    <circle cx="7" cy="6.5" r="2.6"/><circle cx="17" cy="6.5" r="2.6"/>
    <circle cx="12" cy="10" r="5.3"/>
    <ellipse cx="12" cy="18.3" rx="6" ry="4.8"/>
    <circle cx="6.7" cy="16.8" r="1.9"/><circle cx="17.3" cy="16.8" r="1.9"/>
  </g>
  <g fill="#d82f1e">
    <circle cx="10" cy="9.4" r="0.85"/><circle cx="14" cy="9.4" r="0.85"/>
    <ellipse cx="12" cy="11.4" rx="1.25" ry="1"/>
  </g>
</svg>`;

// Escapa texto para innerHTML. Las notificaciones pueden traer datos de TN
// (nombres de producto/cliente), así que las tratamos como no confiables.
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Aviso "hay datos nuevos": comparamos una huella liviana del servidor
// (GET /api/sync-state) contra la última vista. Si cambió → puntito en ↻.
// No recarga nada solo: el operador actualiza cuando quiere.
let _lastSeenFp = null;
let _hasUpdates = false;
let _pollStarted = false;
async function fetchFp() {
  try { return (await api('/api/sync-state'))?.fp ?? null; } catch { return null; }
}

const PAGE_LABELS = {
  '/dashboard': 'Panel',
  '/pos': 'POS',
  '/ventas': 'Ventas',
  '/returns': 'Devoluciones',
  '/cash': 'Caja',
  '/inventory': 'Inventario',
  '/crm': 'Clientes',
  '/balance': 'Saldo',
  '/profits': 'Ganancias',
  '/contribution': 'Contribución marginal',
  '/checks': 'Cheques',
  '/employees': 'Empleados',
  '/tasks': 'Tareas',
  '/calendar': 'Calendario',
  '/reports': 'Reportes',
  '/history': 'Historial',
  '/settings': 'Configuración',
};

const ROLE_LABELS = {
  admin: 'ADMIN',
  cashier: 'CAJERO',
  manager: 'ENCARGADO',
  seller: 'VENDEDOR',
};

export async function mountTopbar(el) {
  const session = Auth.currentSession();
  const branches = await Auth.listBranches();
  const activeId = Auth.activeBranchId();

  const render = async () => {
    const hash = location.hash.slice(1) || '/dashboard';
    const base = '/' + (hash.split('/')[1] || 'dashboard');
    const pageLabel = PAGE_LABELS[base] || 'Ingenium';
    const unread = (await Notif.listAll({ onlyUnread: true })).length;
    const currentBranch = branches.find(b => b.id === Auth.activeBranchId());
    const cashOpen = await Cash.isDayOpen(Auth.activeBranchId());
    // El alternador de sucursal es solo para el admin. Los demás operan en su
    // sucursal fija (la ven junto a su nombre, abajo a la derecha).
    const isAdmin = session?.role === 'admin';

    const uname = session?.user_name || 'Usuario';
    const initials = uname.split(/\s+/).filter(Boolean).map(w => w[0]).slice(0, 2).join('').toUpperCase() || 'U';
    const iconBtn = 'w-9 h-9 rounded-full text-[#7d6c5c] dark:text-[#c9b6a4] hover:bg-[#fff1e6] dark:hover:bg-[#2a2018] flex items-center justify-center transition-colors';
    el.innerHTML = `
      <!-- Marca -->
      <a href="#/dashboard" class="group flex items-center gap-3 shrink-0 min-w-0">
        <div class="w-10 h-10 rounded-full bg-[#d82f1e] flex items-center justify-center shadow-md shrink-0 transition-transform group-hover:scale-105">
          ${TEDDY_SVG}
        </div>
        <div class="leading-tight min-w-0">
          <div class="font-black text-lg sm:text-xl tracking-tight text-[#d82f1e] truncate">Ingenium</div>
          <div class="text-[9px] sm:text-[10px] font-bold uppercase tracking-[0.22em] text-[#7d6c5c] dark:text-[#c9b6a4] truncate">Sistema de Ventas</div>
        </div>
      </a>
      <!-- Controles -->
      <div class="flex items-center gap-2 shrink-0">
        ${isAdmin ? `
        <div class="hidden sm:flex gap-1 items-center bg-[#fff1e6] dark:bg-[#2a2018] rounded-full p-0.5">
          ${branches.map(b => `
            <button data-branch="${b.id}" class="tb-branch px-3 py-1 rounded-full text-xs font-bold transition-all ${b.id === activeId ? 'bg-[#d82f1e] text-white shadow' : 'text-[#7d6c5c] dark:text-[#c9b6a4] hover:bg-white/60 dark:hover:bg-white/5'}">${b.name}</button>
          `).join('')}
        </div>` : ''}
        <a href="#/cash" title="${cashOpen ? 'Caja abierta' : 'Caja cerrada — abrir en Caja'}" class="hidden md:flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-bold transition-all ${cashOpen ? 'bg-green-50 border-green-200 text-green-700' : 'bg-red-50 border-red-200 text-red-600 hover:bg-red-100'}">
          <span class="material-symbols-outlined text-base">${cashOpen ? 'lock_open' : 'lock'}</span>
          ${cashOpen ? 'Caja abierta' : 'Caja cerrada'}
        </a>
        <button id="tb-refresh" title="${_hasUpdates ? 'Hay datos nuevos — tocá para actualizar' : 'Actualizar desde el servidor'}" class="relative ${iconBtn} ${_hasUpdates ? '!text-[#d82f1e]' : ''}">
          <span class="material-symbols-outlined text-[20px]">refresh</span>
          ${_hasUpdates ? `<span class="absolute top-1 right-1 bg-[#d82f1e] w-2.5 h-2.5 rounded-full ring-2 ring-white dark:ring-[#1a1410]"></span>` : ''}
        </button>
        <button id="tb-theme" title="Modo oscuro / claro" class="${iconBtn}">
          <span class="material-symbols-outlined text-[20px]">${document.documentElement.classList.contains('dark') ? 'light_mode' : 'dark_mode'}</span>
        </button>
        <button id="tb-bell" class="relative ${iconBtn}">
          <span class="material-symbols-outlined text-[20px]">notifications</span>
          ${unread > 0 ? `<span class="absolute top-0.5 right-0.5 bg-[#d82f1e] text-white text-[10px] font-black w-4 h-4 rounded-full flex items-center justify-center ring-2 ring-white dark:ring-[#1a1410]">${unread > 9 ? '9+' : unread}</span>` : ''}
        </button>
        <button id="tb-logout" title="Cerrar sesión" class="${iconBtn} hover:!bg-red-50 hover:!text-red-600">
          <span class="material-symbols-outlined text-[20px]">logout</span>
        </button>
        <div class="w-9 h-9 rounded-full bg-[#fff1e6] dark:bg-[#2a2018] border border-[#e3ceba] dark:border-[#3a2e22] text-[#d82f1e] flex items-center justify-center font-black text-sm shrink-0" title="${esc(uname)}${currentBranch ? ' · ' + esc(currentBranch.name) : ''} · ${esc(ROLE_LABELS[session?.role] || session?.role || '')}">${esc(initials)}</div>
      </div>
    `;

    el.querySelectorAll('.tb-branch').forEach(btn => {
      btn.addEventListener('click', async () => {
        const bid = btn.dataset.branch;
        if (bid === Auth.activeBranchId()) return;
        // Si hay borradores con items en la sucursal actual, pedir confirmación
        const currentBr = Auth.activeBranchId();
        const { getAll } = await import('../core/db.js');
        const drafts = (await getAll('draft_sales')).filter(d =>
          (!d.branch_id || d.branch_id === currentBr) && Array.isArray(d.items) && d.items.length > 0
        );
        if (drafts.length) {
          const { confirmModal } = await import('./modal.js');
          const ok = await confirmModal({
            title: 'Hay una venta en curso',
            message: `Tenés ${drafts.length} borrador${drafts.length > 1 ? 'es' : ''} con items en la sucursal actual. Si cambiás, no vas a verlos hasta volver. ¿Cambiar igual?`,
            danger: true, confirmLabel: 'Cambiar sucursal',
          });
          if (!ok) return;
        }
        try {
          await Auth.setActiveBranch(bid);
          emit(EV.BRANCH_CHANGED, bid);
          render();
        } catch (err) {
          const { toast } = await import('../core/notifications.js');
          toast(err.message || 'No se pudo cambiar la sucursal', 'error');
        }
      });
    });
    el.querySelector('#tb-refresh').addEventListener('click', async () => {
      const btn = el.querySelector('#tb-refresh');
      if (btn.dataset.busy) return;
      btn.dataset.busy = '1';
      const icon = btn.querySelector('.material-symbols-outlined');
      icon.classList.add('animate-spin');
      try {
        // 1) Vaciar cachés en memoria (productos, config) y resincronizar el
        //    catálogo (categorías/marcas/proveedores) desde el servidor.
        try { Settings.invalidate?.(); } catch {}
        try { Products.clearCache?.(); } catch {}
        try { await syncCatalog(); } catch {}
        // 2) Re-montar el módulo actual limpio → vuelve a leer del servidor.
        const cur = location.hash.slice(1) || '/dashboard';
        await navigate(cur);
        // 3) Marcar como "visto" el estado actual → apaga el puntito de aviso.
        _lastSeenFp = await fetchFp();
        _hasUpdates = false;
        Notif.toast('Datos actualizados', 'success');
      } catch (e) {
        Notif.toast('No se pudo actualizar: ' + (e?.message || ''), 'error');
      } finally {
        // Re-renderiza el topbar (refresca caja/campana). Reemplaza este nodo,
        // así que no hace falta limpiar el spinner manualmente.
        render();
      }
    });
    el.querySelector('#tb-bell').addEventListener('click', () => openBellPanel());
    el.querySelector('#tb-logout')?.addEventListener('click', () => { try { window.__ingLogout?.(); } catch {} });
    el.querySelector('#tb-theme').addEventListener('click', () => {
      const html = document.documentElement;
      const dark = html.classList.toggle('dark');
      html.classList.toggle('light', !dark);
      try { localStorage.setItem('ingenium_theme', dark ? 'dark' : 'light'); } catch {}
      render();
    });
  };

  await render();
  window.addEventListener('hashchange', render);
  on(EV.NOTIFICATION_NEW, render);
  on(EV.BRANCH_CHANGED, render);
  on(EV.CASH_MOVED, render);

  // Aviso de datos nuevos: baseline + chequeo cada 60s (una sola vez por sesión).
  if (!_pollStarted) {
    _pollStarted = true;
    _lastSeenFp = await fetchFp(); // punto de partida: sin aviso al entrar
    const check = async () => {
      const fp = await fetchFp();
      if (fp && _lastSeenFp && fp !== _lastSeenFp && !_hasUpdates) {
        _hasUpdates = true;
        render();
      }
    };
    setInterval(check, 60_000);
    // También al volver a la pestaña (si estuvo minimizada un rato).
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  }
}

function openBellPanel() {
  const existing = document.getElementById('bell-panel');
  if (existing) { existing.remove(); return; }

  const panel = document.createElement('div');
  panel.id = 'bell-panel';
  panel.className = 'fixed top-20 right-8 w-96 max-h-[70vh] bg-white rounded-3xl shadow-2xl border border-[#fff1e6] overflow-hidden z-[9500]';
  panel.innerHTML = `
    <div class="flex justify-between items-center p-5 border-b border-[#fff1e6]">
      <span class="font-black text-[#241a0d]">Notificaciones</span>
      <button id="bp-markall" class="text-xs text-[#d82f1e] font-bold hover:underline">Marcar todas leídas</button>
    </div>
    <div id="bp-list" class="overflow-y-auto max-h-[60vh] p-2">
      <div class="p-4 text-center text-[#7d6c5c] text-sm">Cargando...</div>
    </div>
  `;
  document.body.appendChild(panel);

  Notif.listAll().then(list => {
    const body = panel.querySelector('#bp-list');
    if (list.length === 0) {
      body.innerHTML = `<div class="p-8 text-center text-[#7d6c5c]"><span class="material-symbols-outlined text-4xl opacity-40">inbox</span><p class="text-sm mt-2">Sin notificaciones</p></div>`;
      return;
    }
    body.innerHTML = list.slice(0, 30).map(n => `
      <div class="p-3 rounded-xl hover:bg-[#fff1e6] flex gap-3 ${n.read_at ? 'opacity-60' : ''}">
        <span class="material-symbols-outlined text-[#d82f1e]">${n.read_at ? 'notifications' : 'notifications_active'}</span>
        <div class="flex-1">
          <div class="font-bold text-sm">${esc(n.title)}</div>
          ${n.body ? `<div class="text-xs text-[#7d6c5c] mt-0.5">${esc(n.body)}</div>` : ''}
          <div class="text-[10px] text-[#c9b6a4] mt-1">${new Date(n.datetime).toLocaleString('es-AR')}</div>
        </div>
      </div>
    `).join('');
  });

  panel.querySelector('#bp-markall').addEventListener('click', async () => {
    await Notif.markAllRead();
    panel.remove();
  });

  const close = (e) => {
    if (!panel.contains(e.target)) { panel.remove(); document.removeEventListener('click', close, true); }
  };
  setTimeout(() => document.addEventListener('click', close, true), 0);
}
