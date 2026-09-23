// Ventas — historial de ventas en forma de listado.
// Cada fila: fecha · hora · método de pago (si es combinado, indica cuáles) · total.
// Al clickear la fila se despliega (chevron) el detalle de productos con su valor c/u.

import { api } from '../core/api.js';
import { getAll } from '../core/db.js';
import { money } from '../core/format.js';
import { activeBranchId } from '../core/auth.js';
import { toast } from '../core/notifications.js';
import { on, EV } from '../core/events.js';

const state = {
  sales: [],
  branch: 'all',
  q: '',
  expanded: new Set(),
};

export async function mount(el) {
  state.branch = 'all';
  await load(el);
  // Refrescar si se confirma/anula una venta mientras el módulo está montado.
  const off = on(EV.SALE_CONFIRMED, () => load(el).catch(() => {}));
  return () => { try { off && off(); } catch { /* noop */ } };
}

async function load(el) {
  el.innerHTML = `<div class="ing-stub"><span class="material-symbols-outlined">hourglass_top</span><p>Cargando ventas…</p></div>`;
  let sales, branches;
  try {
    [sales, branches] = await Promise.all([
      api('/api/sales?status=confirmed&limit=1000'),
      getAll('branches'),
    ]);
  } catch (e) {
    if (e?.status === 0) {
      el.innerHTML = `<div class="ing-card p-6 text-center"><span class="material-symbols-outlined text-4xl text-amber-500">cloud_off</span>
        <p class="mt-2 font-bold">Sin conexión</p><p class="text-sm text-[#7d6c5c]">El historial de ventas necesita internet.</p></div>`;
      return;
    }
    el.innerHTML = `<div class="ing-card p-6 text-center"><span class="material-symbols-outlined text-4xl text-red-500">error</span>
      <p class="mt-2 font-bold">No se pudieron cargar las ventas</p><p class="text-sm text-[#7d6c5c]">${escapeHtml(e.message || '')}</p></div>`;
    return;
  }
  state.sales = (sales || []).sort((a, b) => String(b.datetime).localeCompare(String(a.datetime)));
  state.brMap = Object.fromEntries((branches || []).map(b => [b.id, b.name]));
  render(el);
}

function filtered() {
  const q = state.q.trim().toLowerCase();
  return state.sales.filter(s => {
    if (state.branch !== 'all' && s.branchId !== state.branch) return false;
    if (!q) return true;
    if (String(s.number).includes(q)) return true;
    if ((s.customer?.name || '').toLowerCase().includes(q)) return true;
    return (s.items || []).some(it => (it.productNameSnap || '').toLowerCase().includes(q));
  });
}

// Etiqueta de método de pago. Combinado -> "Efectivo ($x) + Tarjeta ($y)".
function payLabel(sale) {
  const pays = sale.payments || [];
  if (pays.length === 0) return '—';
  if (pays.length === 1) return pays[0].methodName || pays[0].methodId || '—';
  return pays.map(p => `${p.methodName || p.methodId} (${money(p.amount)})`).join(' + ');
}

function render(el) {
  const list = filtered();
  const branchOpts = ['<option value="all">Todas las sucursales</option>']
    .concat(Object.entries(state.brMap || {}).map(([id, name]) =>
      `<option value="${id}" ${state.branch === id ? 'selected' : ''}>${escapeHtml(name)}</option>`)).join('');

  const totalPeriodo = list.reduce((s, x) => s + (x.total || 0), 0);

  el.innerHTML = `
    <div class="mb-6 flex flex-wrap justify-between items-start gap-4">
      <div>
        <h1 class="text-3xl font-black text-[#241a0d] dark:text-[#fff1e6]">Ventas</h1>
        <p class="text-sm text-[#7d6c5c] mt-1">Historial · ${list.length} venta(s) · Total ${money(totalPeriodo)}</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <input id="v-q" placeholder="Buscar N°, cliente o producto…" class="ing-input w-64" value="${escapeHtml(state.q)}" />
        <select id="v-br" class="ing-input">${branchOpts}</select>
      </div>
    </div>

    <div class="ing-card overflow-hidden">
      <div class="hidden md:grid grid-cols-[auto_1fr_1.4fr_auto] gap-3 px-4 py-2 text-[0.7rem] font-black uppercase tracking-wider text-[#7d6c5c] border-b border-[#fff1e6] dark:border-[#2a2018]">
        <span class="w-6"></span>
        <span>Fecha y hora</span>
        <span>Método de pago</span>
        <span class="text-right">Total</span>
      </div>
      <div id="v-rows">
        ${list.length ? list.map(rowHTML).join('') : `
          <div class="p-10 text-center text-[#7d6c5c]">
            <span class="material-symbols-outlined text-4xl">receipt_long</span>
            <p class="mt-2 font-bold">No hay ventas para mostrar</p>
          </div>`}
      </div>
    </div>
  `;

  wire(el);
}

function rowHTML(s) {
  const d = new Date(s.datetime);
  const fecha = d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const hora = d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  const open = state.expanded.has(s.id);
  const origen = s.source === 'tn'
    ? '<span class="text-[0.6rem] font-black uppercase bg-[#eaf3ff] text-[#2563eb] px-1.5 py-0.5 rounded-full">TN</span>'
    : '<span class="text-[0.6rem] font-black uppercase bg-[#fff1e6] text-[#d82f1e] px-1.5 py-0.5 rounded-full">POS</span>';
  const combinado = (s.payments || []).length > 1
    ? '<span class="ml-1 text-[0.6rem] font-black uppercase bg-[#f3e8ff] text-[#7c3aed] px-1.5 py-0.5 rounded-full">Combinado</span>'
    : '';

  const items = (s.items || []).map(it => {
    const variante = it.variantNameSnap && it.variantNameSnap !== 'default' ? ` · ${escapeHtml(it.variantNameSnap)}` : '';
    return `
      <div class="flex justify-between items-start gap-3 py-1.5 border-b border-[#fff8f4] dark:border-[#241a0d] last:border-0">
        <div class="min-w-0">
          <div class="text-sm text-[#241a0d] dark:text-[#fff1e6] truncate">${escapeHtml(it.productNameSnap || '')}${variante}</div>
          <div class="text-xs text-[#7d6c5c]">${it.qty} × ${money(it.unitPrice)} c/u</div>
        </div>
        <div class="text-sm font-bold text-[#241a0d] dark:text-[#fff1e6] whitespace-nowrap">${money(it.subtotal)}</div>
      </div>`;
  }).join('');

  return `
    <div class="border-b border-[#fff1e6] dark:border-[#2a2018] last:border-0">
      <button type="button" data-row="${s.id}" class="w-full text-left px-4 py-3 grid grid-cols-[auto_1fr_auto] md:grid-cols-[auto_1fr_1.4fr_auto] gap-3 items-center hover:bg-[#fff8f4] dark:hover:bg-[#241a0d] transition-colors">
        <span class="material-symbols-outlined text-[#7d6c5c] transition-transform ${open ? 'rotate-90' : ''}" data-chev="${s.id}">chevron_right</span>
        <span class="min-w-0">
          <span class="block font-bold text-[#241a0d] dark:text-[#fff1e6]">${fecha} <span class="text-[#7d6c5c] font-semibold">${hora}</span></span>
          <span class="block text-xs text-[#7d6c5c] truncate">#${String(s.number).padStart(6, '0')} · ${origen}${s.customer?.name ? ' · ' + escapeHtml(s.customer.name) : ''}</span>
        </span>
        <span class="hidden md:block text-sm text-[#241a0d] dark:text-[#fff1e6]">${escapeHtml(payLabel(s))}${combinado}</span>
        <span class="text-right font-black text-[#d82f1e] whitespace-nowrap">${money(s.total)}</span>
      </button>
      <div data-detail="${s.id}" class="${open ? '' : 'hidden'} px-4 md:px-12 pb-3">
        <div class="md:hidden mb-2 text-xs text-[#7d6c5c]"><b>Pago:</b> ${escapeHtml(payLabel(s))}</div>
        <div class="bg-[#fffdfb] dark:bg-[#1c150e] border border-[#fff1e6] dark:border-[#2a2018] rounded-xl px-3 py-2">
          ${items || '<div class="text-sm text-[#7d6c5c] py-1">Sin items</div>'}
          <div class="flex justify-between items-center pt-2 mt-1 border-t border-[#fff1e6] dark:border-[#2a2018]">
            <span class="text-xs font-black uppercase tracking-wider text-[#7d6c5c]">Total venta</span>
            <span class="font-black text-[#d82f1e]">${money(s.total)}</span>
          </div>
        </div>
      </div>
    </div>`;
}

function wire(el) {
  const q = el.querySelector('#v-q');
  if (q) {
    let t;
    q.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => { state.q = q.value; render(el); const nq = el.querySelector('#v-q'); if (nq) { nq.focus(); nq.setSelectionRange(nq.value.length, nq.value.length); } }, 200);
    });
  }
  const br = el.querySelector('#v-br');
  if (br) br.addEventListener('change', () => { state.branch = br.value; render(el); });

  el.querySelectorAll('[data-row]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.row;
      const detail = el.querySelector(`[data-detail="${CSS.escape(id)}"]`);
      const chev = el.querySelector(`[data-chev="${CSS.escape(id)}"]`);
      const willOpen = state.expanded.has(id) ? (state.expanded.delete(id), false) : (state.expanded.add(id), true);
      if (detail) detail.classList.toggle('hidden', !willOpen);
      if (chev) chev.classList.toggle('rotate-90', willOpen);
    });
  });
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
