// Topbar: título del módulo activo, selector sucursal, bell, avatar.

import * as Auth from '../core/auth.js';
import * as Notif from '../core/notifications.js';
import * as Cash from '../repos/cash.js';
import { on, EV, emit } from '../core/events.js';

const PAGE_LABELS = {
  '/dashboard': 'Panel',
  '/pos': 'Ventas',
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

    el.innerHTML = `
      <div class="flex items-center gap-10">
        <span class="text-xl font-black uppercase tracking-[0.05em] text-[#d82f1e]">Ingenium</span>
        <span class="text-[#7d6c5c] font-semibold text-sm">/ ${pageLabel}</span>
      </div>
      <div class="flex items-center gap-5">
        <div class="flex gap-2 items-center">
          ${branches.map(b => `
            <button data-branch="${b.id}" class="tb-branch px-4 py-1.5 rounded-full text-xs font-bold transition-all ${b.id === activeId ? 'bg-[#d82f1e] text-white shadow' : 'text-[#7d6c5c] hover:bg-[#fff1e6]'}">${b.name}</button>
          `).join('')}
        </div>
        <div class="flex items-center gap-2 px-4 py-1.5 bg-[#fff1e6] rounded-full border border-[#e3ceba]">
          <span class="material-symbols-outlined text-[#d82f1e] text-lg">admin_panel_settings</span>
          <span class="text-xs font-bold text-[#b41005]">${ROLE_LABELS[session?.role] || (session?.role || '').toUpperCase()}</span>
        </div>
        <a href="#/cash" title="${cashOpen ? 'Caja abierta' : 'Caja cerrada — abrir en Caja'}" class="flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-bold transition-all ${cashOpen ? 'bg-green-50 border-green-200 text-green-700' : 'bg-red-50 border-red-200 text-red-700 hover:bg-red-100'}">
          <span class="material-symbols-outlined text-base">${cashOpen ? 'lock_open' : 'lock'}</span>
          ${cashOpen ? 'Caja abierta' : 'Caja cerrada'}
        </a>
        <div class="flex items-center gap-2">
          <button id="tb-theme" title="Modo oscuro / claro" class="p-2.5 text-[#7d6c5c] hover:bg-[#fff1e6] rounded-full transition-all">
            <span class="material-symbols-outlined">${document.documentElement.classList.contains('dark') ? 'light_mode' : 'dark_mode'}</span>
          </button>
          <button id="tb-bell" class="relative p-2.5 text-[#7d6c5c] hover:bg-[#fff1e6] rounded-full transition-all">
            <span class="material-symbols-outlined">notifications</span>
            ${unread > 0 ? `<span class="absolute top-1 right-1 bg-[#d82f1e] text-white text-[10px] font-black w-4 h-4 rounded-full flex items-center justify-center">${unread > 9 ? '9+' : unread}</span>` : ''}
          </button>
          <button class="p-2.5 text-[#7d6c5c] hover:bg-[#fff1e6] rounded-full transition-all" onclick="location.hash='/settings'">
            <span class="material-symbols-outlined">settings</span>
          </button>
          <div class="flex items-center gap-3 pl-3 border-l border-[#e3ceba]">
            <div class="text-right">
              <div class="text-xs font-bold text-[#241a0d] leading-tight">${session?.user_name || ''}</div>
              <div class="text-[10px] text-[#7d6c5c]">${currentBranch?.name || ''}</div>
            </div>
            <div class="w-10 h-10 rounded-full border-2 border-[#d82f1e]/20 p-0.5 bg-[#fff1e6] flex items-center justify-center">
              <span class="material-symbols-outlined text-[#d82f1e]">person</span>
            </div>
          </div>
        </div>
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
    el.querySelector('#tb-bell').addEventListener('click', () => openBellPanel());
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
          <div class="font-bold text-sm">${n.title}</div>
          ${n.body ? `<div class="text-xs text-[#7d6c5c] mt-0.5">${n.body}</div>` : ''}
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
