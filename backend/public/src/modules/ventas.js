// Ventas — historial de ventas (y devoluciones) en forma de listado.
// Cada fila: fecha · hora · método de pago (combinado indica cuáles) · total.
// Las DEVOLUCIONES aparecen como importe negativo y descuentan del total facturado.
// Al clickear una fila se despliega (chevron) el detalle de productos con su valor c/u.
// Boxes de total facturado / devuelto / neto (estilo dashboard), según el período.

import { api } from '../core/api.js';
import { getAll, get } from '../core/db.js';
import { money, fmtDateTime, todayKey } from '../core/format.js';
import { activeBranchId } from '../core/auth.js';
import { toast } from '../core/notifications.js';
import { on, EV } from '../core/events.js';
import { openModal, confirmModal } from '../components/modal.js';

const AR = '-03:00';

const state = {
  period: 'month',
  date: todayKey(),
  customFrom: todayKey(),
  customTo: todayKey(),
  branch: 'all',
  method: '',
  type: 'all', // all | sale | return
  source: '', // '' | pos | tn
  q: '',
  expanded: new Set(),
  entries: [],
  vName: {},
  brMap: {},
  methods: [],
};

export async function mount(el) {
  await load(el);
  const off = on(EV.SALE_CONFIRMED, () => load(el).catch(() => {}));
  const off2 = on(EV.RETURN_CONFIRMED, () => load(el).catch(() => {}));
  return () => { try { off && off(); off2 && off2(); } catch { /* noop */ } };
}

function rangeISO() {
  let fromD, toD;
  if (state.period === 'day') {
    fromD = new Date(`${state.date}T00:00:00.000${AR}`); toD = new Date(fromD.getTime() + 86400000);
  } else if (state.period === 'month') {
    const m = state.date.slice(0, 7); fromD = new Date(`${m}-01T00:00:00.000${AR}`);
    const [y, mm] = m.split('-').map(Number); const ny = mm === 12 ? y + 1 : y, nm = mm === 12 ? 1 : mm + 1;
    toD = new Date(`${ny}-${String(nm).padStart(2, '0')}-01T00:00:00.000${AR}`);
  } else if (state.period === 'year') {
    const y = state.date.slice(0, 4); fromD = new Date(`${y}-01-01T00:00:00.000${AR}`); toD = new Date(`${Number(y) + 1}-01-01T00:00:00.000${AR}`);
  } else if (state.period === 'custom') {
    fromD = new Date(`${state.customFrom || todayKey()}T00:00:00.000${AR}`);
    toD = new Date(new Date(`${state.customTo || todayKey()}T00:00:00.000${AR}`).getTime() + 86400000);
  } else { // all
    return { from: null, to: null };
  }
  return { from: fromD.toISOString(), to: toD.toISOString() };
}

async function load(el) {
  el.innerHTML = `<div class="ing-stub"><span class="material-symbols-outlined">hourglass_top</span><p>Cargando ventas…</p></div>`;
  const { from, to } = rangeISO();
  let sales, returns, products, branches, methodsCfg;
  try {
    const qs = new URLSearchParams({ status: 'confirmed', limit: '2000' });
    if (from) { qs.set('from', from); qs.set('to', to); }
    [sales, returns, products, branches, methodsCfg] = await Promise.all([
      api(`/api/sales?${qs.toString()}`),
      api('/api/returns'),
      getAll('products'),
      getAll('branches'),
      get('config', 'payment_methods'),
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

  state.methods = methodsCfg?.value || [];
  state.brMap = Object.fromEntries((branches || []).map(b => [b.id, b.name]));
  // variantId -> nombre legible (para el detalle de las devoluciones, que sólo guardan variantId)
  state.vName = {};
  for (const p of (products || [])) {
    for (const v of (p.variants || [])) {
      const suf = v.name && v.name !== 'default' ? ` · ${v.name}` : '';
      state.vName[v.id] = `${p.name}${suf}`;
    }
  }

  // Filtrar devoluciones por rango de fecha en el cliente (el endpoint no filtra por fecha).
  const inRange = (dt) => {
    if (!from) return true;
    const t = new Date(dt).getTime();
    return t >= new Date(from).getTime() && t < new Date(to).getTime();
  };

  const saleEntries = (sales || []).map(s => ({
    kind: 'sale',
    id: s.id, number: s.number, datetime: s.datetime, branchId: s.branchId, source: s.source,
    customerName: s.customer?.name || '', payments: s.payments || [],
    amount: s.total || 0,
    items: (s.items || []).map(it => ({
      name: `${it.productNameSnap}${it.variantNameSnap && it.variantNameSnap !== 'default' ? ` · ${it.variantNameSnap}` : ''}`,
      qty: it.qty, unitPrice: it.unitPrice, subtotal: it.subtotal,
    })),
    raw: s,
  }));

  const returnEntries = (returns || []).filter(r => inRange(r.datetime)).map(r => ({
    kind: 'return',
    id: r.id, number: r.number, datetime: r.datetime, branchId: r.branchId, source: r.source || 'pos',
    customerName: '', payments: r.payments || [],
    amount: -(r.returnedTotal || 0), // negativo: descuenta del facturado
    returnedTotal: r.returnedTotal || 0, takenTotal: r.takenTotal || 0, difference: r.difference || 0,
    returnedItems: (r.returnedItems || []).map(it => ({ name: state.vName[it.variantId] || it.variantId, qty: it.qty, unitPrice: it.unitPrice })),
    takenItems: (r.takenItems || []).map(it => ({ name: state.vName[it.variantId] || it.variantId, qty: it.qty, unitPrice: it.unitPrice })),
    raw: r,
  }));

  state.entries = [...saleEntries, ...returnEntries].sort((a, b) => String(b.datetime).localeCompare(String(a.datetime)));
  render(el);
}

function filtered() {
  const q = state.q.trim().toLowerCase();
  return state.entries.filter(e => {
    if (state.type !== 'all' && e.kind !== state.type) return false;
    if (state.branch !== 'all' && e.branchId !== state.branch) return false;
    if (state.source && e.source !== state.source) return false;
    if (state.method && !(e.payments || []).some(p => (p.methodName || p.methodId) === state.method)) return false;
    if (!q) return true;
    if (String(e.number).includes(q)) return true;
    if ((e.customerName || '').toLowerCase().includes(q)) return true;
    const items = e.kind === 'sale' ? e.items : [...(e.returnedItems || []), ...(e.takenItems || [])];
    return (items || []).some(it => (it.name || '').toLowerCase().includes(q));
  });
}

function render(el) {
  const list = filtered();
  const facturado = list.filter(e => e.kind === 'sale').reduce((s, e) => s + e.amount, 0);
  const devuelto = list.filter(e => e.kind === 'return').reduce((s, e) => s + e.returnedTotal, 0);
  const neto = facturado - devuelto;
  const nVentas = list.filter(e => e.kind === 'sale').length;
  const nDev = list.filter(e => e.kind === 'return').length;

  const methodOpts = ['<option value="">Todos los medios</option>']
    .concat((state.methods || []).map(m => `<option value="${escapeHtml(m.name)}" ${state.method === m.name ? 'selected' : ''}>${escapeHtml(m.name)}</option>`)).join('');
  const branchOpts = ['<option value="all">Todas las sucursales</option>']
    .concat(Object.entries(state.brMap || {}).map(([id, name]) => `<option value="${id}" ${state.branch === id ? 'selected' : ''}>${escapeHtml(name)}</option>`)).join('');

  const dateInput = state.period === 'custom' ? `
      <input id="v-from" type="date" value="${state.customFrom}" class="ing-input" title="Desde" />
      <input id="v-to" type="date" value="${state.customTo}" class="ing-input" title="Hasta" />
    ` : state.period === 'all' ? '' : `
      <input id="v-date" type="${state.period === 'year' ? 'number' : state.period === 'month' ? 'month' : 'date'}"
        value="${state.period === 'year' ? state.date.slice(0, 4) : state.period === 'month' ? state.date.slice(0, 7) : state.date}" class="ing-input" />`;

  el.innerHTML = `
    <div class="mb-5 flex flex-wrap justify-between items-start gap-4">
      <div>
        <h1 class="text-3xl font-black text-[#241a0d] dark:text-[#fff1e6]">Ventas</h1>
        <p class="text-sm text-[#7d6c5c] mt-1">Historial de ventas y devoluciones</p>
      </div>
    </div>

    <div class="grid grid-cols-2 md:grid-cols-3 gap-3 mb-5">
      <div class="ing-card p-4">
        <div class="text-[10px] font-black uppercase text-[#7d6c5c]">Total facturado</div>
        <div class="text-3xl font-black text-[#d82f1e] mt-1">${money(facturado)}</div>
        <div class="text-xs text-[#7d6c5c]">${nVentas} venta(s)</div>
      </div>
      <div class="ing-card p-4">
        <div class="text-[10px] font-black uppercase text-[#7d6c5c]">Devuelto</div>
        <div class="text-3xl font-black text-orange-600 mt-1">− ${money(devuelto)}</div>
        <div class="text-xs text-[#7d6c5c]">${nDev} devolución(es)</div>
      </div>
      <div class="ing-card p-4">
        <div class="text-[10px] font-black uppercase text-[#7d6c5c]">Neto</div>
        <div class="text-3xl font-black text-green-700 mt-1">${money(neto)}</div>
      </div>
    </div>

    <div class="ing-card p-3 mb-4">
      <div class="flex flex-wrap gap-2 items-center">
        <div class="flex gap-1">
          ${['day', 'month', 'year', 'custom', 'all'].map(p => `<button data-period="${p}" class="px-3 py-1.5 text-xs font-bold rounded-lg ${state.period === p ? 'bg-[#d82f1e] text-white' : 'bg-[#fff1e6] text-[#7d6c5c]'}">${{ day: 'Día', month: 'Mes', year: 'Año', custom: 'Rango', all: 'Todo' }[p]}</button>`).join('')}
        </div>
        ${dateInput}
        <select id="v-type" class="ing-input">
          <option value="all" ${state.type === 'all' ? 'selected' : ''}>Ventas y devoluciones</option>
          <option value="sale" ${state.type === 'sale' ? 'selected' : ''}>Sólo ventas</option>
          <option value="return" ${state.type === 'return' ? 'selected' : ''}>Sólo devoluciones</option>
        </select>
        <select id="v-method" class="ing-input">${methodOpts}</select>
        <select id="v-br" class="ing-input">${branchOpts}</select>
        <select id="v-source" class="ing-input">
          <option value="" ${state.source === '' ? 'selected' : ''}>Todo origen</option>
          <option value="pos" ${state.source === 'pos' ? 'selected' : ''}>POS</option>
          <option value="tn" ${state.source === 'tn' ? 'selected' : ''}>Tienda Nube</option>
        </select>
        <input id="v-q" placeholder="Buscar N°, cliente o producto…" class="ing-input flex-1 min-w-[180px]" value="${escapeHtml(state.q)}" />
      </div>
    </div>

    <div class="ing-card overflow-hidden">
      <div class="hidden md:grid grid-cols-[auto_1fr_1.4fr_auto] gap-3 px-4 py-2 text-[0.7rem] font-black uppercase tracking-wider text-[#7d6c5c] border-b border-[#fff1e6] dark:border-[#2a2018]">
        <span class="w-6"></span><span>Fecha y hora</span><span>Método de pago</span><span class="text-right">Total</span>
      </div>
      <div id="v-rows">
        ${list.length ? list.map(rowHTML).join('') : `
          <div class="p-10 text-center text-[#7d6c5c]"><span class="material-symbols-outlined text-4xl">receipt_long</span>
            <p class="mt-2 font-bold">No hay movimientos para mostrar</p></div>`}
      </div>
    </div>
  `;

  wire(el);
}

function payLabel(e) {
  const pays = e.payments || [];
  if (pays.length === 0) return '—';
  if (pays.length === 1) return pays[0].methodName || pays[0].methodId || '—';
  return pays.map(p => `${p.methodName || p.methodId} (${money(p.amount)})`).join(' + ');
}

function rowHTML(e) {
  const d = new Date(e.datetime);
  const fecha = d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const hora = d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  const open = state.expanded.has(e.id);
  const isReturn = e.kind === 'return';
  const tag = isReturn
    ? '<span class="text-[0.6rem] font-black uppercase bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded-full">Devolución</span>'
    : (e.source === 'tn'
        ? '<span class="text-[0.6rem] font-black uppercase bg-[#eaf3ff] text-[#2563eb] px-1.5 py-0.5 rounded-full">TN</span>'
        : '<span class="text-[0.6rem] font-black uppercase bg-[#fff1e6] text-[#d82f1e] px-1.5 py-0.5 rounded-full">POS</span>');
  const combinado = (e.payments || []).length > 1
    ? '<span class="ml-1 text-[0.6rem] font-black uppercase bg-[#f3e8ff] text-[#7c3aed] px-1.5 py-0.5 rounded-full">Combinado</span>' : '';

  const amountHTML = isReturn
    ? `<span class="text-right font-black text-orange-600 whitespace-nowrap">− ${money(e.returnedTotal)}</span>`
    : `<span class="text-right font-black text-[#d82f1e] whitespace-nowrap">${money(e.amount)}</span>`;

  let detail = '';
  if (isReturn) {
    const ri = (e.returnedItems || []).map(it => lineItem(it, 'Devuelto')).join('');
    const ti = (e.takenItems || []).map(it => lineItem(it, 'Llevado')).join('');
    detail = `
      ${ri ? `<div class="text-xs font-black uppercase tracking-wider text-[#7d6c5c] mb-1">Productos devueltos</div>${ri}` : ''}
      ${ti ? `<div class="text-xs font-black uppercase tracking-wider text-[#7d6c5c] mt-2 mb-1">Productos llevados (canje)</div>${ti}` : ''}
      <div class="flex justify-between items-center pt-2 mt-1 border-t border-[#fff1e6] dark:border-[#2a2018]">
        <span class="text-xs font-black uppercase tracking-wider text-[#7d6c5c]">Diferencia</span>
        <span class="font-black ${e.difference >= 0 ? 'text-orange-600' : 'text-green-700'}">${money(e.difference)}</span>
      </div>`;
  } else {
    const items = (e.items || []).map(it => lineItem(it)).join('');
    detail = `
      ${items || '<div class="text-sm text-[#7d6c5c] py-1">Sin items</div>'}
      <div class="flex justify-between items-center pt-2 mt-1 border-t border-[#fff1e6] dark:border-[#2a2018]">
        <span class="text-xs font-black uppercase tracking-wider text-[#7d6c5c]">Total venta</span>
        <span class="font-black text-[#d82f1e]">${money(e.amount)}</span>
      </div>
      <div class="flex gap-2 mt-3">
        <button data-print="${e.id}" class="ing-btn-secondary flex items-center gap-1 text-sm"><span class="material-symbols-outlined text-base">print</span> Imprimir recibo</button>
        <button data-del="${e.id}" class="ing-btn-secondary flex items-center gap-1 text-sm !text-red-600 !border-red-200"><span class="material-symbols-outlined text-base">delete</span> Eliminar venta</button>
      </div>`;
  }

  return `
    <div class="border-b border-[#fff1e6] dark:border-[#2a2018] last:border-0">
      <button type="button" data-row="${e.id}" class="w-full text-left px-4 py-3 grid grid-cols-[auto_1fr_auto] md:grid-cols-[auto_1fr_1.4fr_auto] gap-3 items-center hover:bg-[#fff8f4] dark:hover:bg-[#241a0d] transition-colors">
        <span class="material-symbols-outlined text-[#7d6c5c] transition-transform ${open ? 'rotate-90' : ''}" data-chev="${e.id}">chevron_right</span>
        <span class="min-w-0">
          <span class="block font-bold text-[#241a0d] dark:text-[#fff1e6]">${fecha} <span class="text-[#7d6c5c] font-semibold">${hora}</span></span>
          <span class="block text-xs text-[#7d6c5c] truncate">#${String(e.number).padStart(6, '0')} · ${tag}${e.customerName ? ' · ' + escapeHtml(e.customerName) : ''}</span>
        </span>
        <span class="hidden md:block text-sm text-[#241a0d] dark:text-[#fff1e6]">${escapeHtml(payLabel(e))}${combinado}</span>
        ${amountHTML}
      </button>
      <div data-detail="${e.id}" class="${open ? '' : 'hidden'} px-4 md:px-12 pb-3">
        <div class="md:hidden mb-2 text-xs text-[#7d6c5c]"><b>Pago:</b> ${escapeHtml(payLabel(e))}</div>
        <div class="bg-[#fffdfb] dark:bg-[#1c150e] border border-[#fff1e6] dark:border-[#2a2018] rounded-xl px-3 py-2">${detail}</div>
      </div>
    </div>`;
}

function lineItem(it, badge) {
  const b = badge ? `<span class="text-[0.6rem] font-bold uppercase text-[#7d6c5c] mr-1">${badge}</span>` : '';
  return `
    <div class="flex justify-between items-start gap-3 py-1.5 border-b border-[#fff8f4] dark:border-[#241a0d] last:border-0">
      <div class="min-w-0">
        <div class="text-sm text-[#241a0d] dark:text-[#fff1e6] truncate">${b}${escapeHtml(it.name || '')}</div>
        <div class="text-xs text-[#7d6c5c]">${it.qty} × ${money(it.unitPrice)} c/u</div>
      </div>
      <div class="text-sm font-bold text-[#241a0d] dark:text-[#fff1e6] whitespace-nowrap">${money(it.subtotal != null ? it.subtotal : it.qty * it.unitPrice)}</div>
    </div>`;
}

function wire(el) {
  const reRender = () => render(el);
  el.querySelectorAll('[data-period]').forEach(b => b.addEventListener('click', () => {
    state.period = b.dataset.period;
    if (state.period === 'custom' && !state.customFrom) { state.customFrom = todayKey(); state.customTo = todayKey(); }
    load(el);
  }));
  const dt = el.querySelector('#v-date');
  if (dt) dt.addEventListener('change', ev => {
    state.date = state.period === 'year' ? `${ev.target.value}-01-01` : state.period === 'month' ? `${ev.target.value}-01` : ev.target.value;
    load(el);
  });
  const f = el.querySelector('#v-from'); if (f) f.addEventListener('change', ev => { state.customFrom = ev.target.value; load(el); });
  const t = el.querySelector('#v-to'); if (t) t.addEventListener('change', ev => { state.customTo = ev.target.value; load(el); });

  el.querySelector('#v-type')?.addEventListener('change', ev => { state.type = ev.target.value; reRender(); });
  el.querySelector('#v-method')?.addEventListener('change', ev => { state.method = ev.target.value; reRender(); });
  el.querySelector('#v-br')?.addEventListener('change', ev => { state.branch = ev.target.value; reRender(); });
  el.querySelector('#v-source')?.addEventListener('change', ev => { state.source = ev.target.value; reRender(); });
  const q = el.querySelector('#v-q');
  if (q) {
    let tm;
    q.addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(() => { state.q = q.value; reRender(); const nq = el.querySelector('#v-q'); if (nq) { nq.focus(); nq.setSelectionRange(nq.value.length, nq.value.length); } }, 200); });
  }

  el.querySelectorAll('[data-row]').forEach(btn => btn.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-print]') || ev.target.closest('[data-del]')) return;
    const id = btn.dataset.row;
    const detail = el.querySelector(`[data-detail="${CSS.escape(id)}"]`);
    const chev = el.querySelector(`[data-chev="${CSS.escape(id)}"]`);
    const willOpen = state.expanded.has(id) ? (state.expanded.delete(id), false) : (state.expanded.add(id), true);
    if (detail) detail.classList.toggle('hidden', !willOpen);
    if (chev) chev.classList.toggle('rotate-90', willOpen);
  }));

  el.querySelectorAll('[data-print]').forEach(b => b.addEventListener('click', () => {
    const e = state.entries.find(x => x.id === b.dataset.print);
    if (e) printReceipt(e);
  }));
  el.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
    const e = state.entries.find(x => x.id === b.dataset.del);
    if (e) deleteSale(e, el);
  }));
}

async function deleteSale(e, el) {
  let returnToTn = true;
  await openModal({
    title: `Eliminar venta #${String(e.number).padStart(6, '0')}`,
    size: 'sm',
    bodyHTML: `
      <p class="text-sm text-[#241a0d] dark:text-[#fff1e6]">Se anulará la venta por <b>${money(e.amount)}</b>, se restaurará el stock y se descontará de la caja el efectivo que había ingresado. <b>No</b> se emite nota de crédito.</p>
      <label class="flex items-center gap-2 mt-4 text-sm cursor-pointer">
        <input type="checkbox" id="del-tn" checked class="w-4 h-4" />
        <span>Devolver los productos a Tienda Nube (reponer stock online)</span>
      </label>
      <input id="del-reason" class="ing-input w-full mt-3" placeholder="Motivo (opcional)" />
    `,
    footerHTML: `
      <button class="ing-btn-secondary" data-act="cancel">Cancelar</button>
      <button class="ing-btn-primary !bg-red-600" data-act="ok">Eliminar venta</button>
    `,
    onOpen: (root, close) => {
      root.querySelector('[data-act="cancel"]').addEventListener('click', () => close(false));
      root.querySelector('[data-act="ok"]').addEventListener('click', async () => {
        returnToTn = root.querySelector('#del-tn').checked;
        const reason = root.querySelector('#del-reason').value || undefined;
        close(true);
        try {
          await api(`/api/sales/${encodeURIComponent(e.id)}/cancel`, { method: 'POST', body: { reason, returnToTn } });
          toast(`Venta #${e.number} eliminada`, 'success');
          state.expanded.delete(e.id);
          await load(el);
        } catch (err) {
          toast('No se pudo eliminar: ' + (err.message || ''), 'error');
        }
      });
    },
  });
}

function printReceipt(e) {
  const w = window.open('', '_blank', 'width=360,height=640');
  if (!w) { toast('El navegador bloqueó la ventana de impresión', 'error'); return; }
  const rows = (e.items || []).map(it => `
    <tr><td>${it.qty} × ${escapeHtml(it.name)}</td><td style="text-align:right">${money(it.subtotal != null ? it.subtotal : it.qty * it.unitPrice)}</td></tr>`).join('');
  const pays = (e.payments || []).map(p => `<div class="pay"><span>${escapeHtml(p.methodName || p.methodId)}</span><span>${money(p.amount)}</span></div>`).join('');
  const d = new Date(e.datetime);
  w.document.write(`<!DOCTYPE html>
<html lang="es-AR"><head><meta charset="utf-8"><title>Recibo ${e.number}</title>
<style>
  *{box-sizing:border-box}body{font:12px/1.4 -apple-system,Segoe UI,sans-serif;padding:12px;color:#111}
  h1{font-size:16px;margin:0 0 4px;letter-spacing:1px}.muted{color:#666;font-size:11px}
  table{width:100%;border-collapse:collapse;margin:8px 0}td{padding:2px 0;vertical-align:top}
  hr{border:0;border-top:1px dashed #999;margin:8px 0}.tot{font-weight:bold;font-size:14px;display:flex;justify-content:space-between}
  .pay{display:flex;justify-content:space-between;font-size:11px}@media print{@page{margin:8mm}}
</style></head><body>
  <h1>INGENIUM</h1>
  <div class="muted">Recibo N° ${String(e.number).padStart(6, '0')}</div>
  <div class="muted">${d.toLocaleString('es-AR')}</div>
  ${e.customerName ? `<div class="muted">Cliente: ${escapeHtml(e.customerName)}</div>` : ''}
  <hr><table>${rows}</table><hr>
  <div class="tot"><span>TOTAL</span><span>${money(e.amount)}</span></div>
  <hr>${pays}<hr>
  <div class="muted" style="text-align:center">¡Gracias por su compra!</div>
  <script>window.onload=()=>{window.print();setTimeout(()=>window.close(),300)};<\/script>
</body></html>`);
  w.document.close();
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
