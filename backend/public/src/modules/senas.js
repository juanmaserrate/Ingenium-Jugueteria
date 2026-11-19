// Módulo Señas: reservas con anticipo. Listado de señas activas / usadas / devueltas, plata
// retenida, alta, devolución (eligiendo el medio) y comprobante.
//
// Reglas de la plata:
//  - Al CREAR la seña: si es en efectivo entra a la caja de la sucursal; otro medio no la mueve.
//  - Al USARLA en una venta (POS): no mueve la caja. Si la seña es mayor que la venta, el
//    sobrante se devuelve por el medio que se elija (efectivo → sale de la caja).
//  - Al DEVOLVERLA (cancelar): se elige el medio; efectivo → sale de la caja.
//  - Si se anula la venta donde se usó, la seña vuelve a quedar activa.

import * as Senas from '../repos/senas.js';
import { api } from '../core/api.js';
import { money, fmtDateTime } from '../core/format.js';
import { toast } from '../core/notifications.js';
import { openNewSenaModal, openRefundModal, printSena } from './senas-ui.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const STATUS = {
  active: { label: 'Activa', cls: 'bg-indigo-100 text-indigo-700' },
  redeemed: { label: 'Usada', cls: 'bg-green-100 text-green-700' },
  cancelled: { label: 'Devuelta', cls: 'bg-gray-200 text-gray-700' },
};

export async function mount(el) {
  // Una seña se puede usar o devolver en cualquier sucursal: por defecto se ven todas.
  const state = { status: 'active', branch: '', q: '', rows: [], branches: [] };
  try { state.branches = await api('/auth/branches'); } catch { state.branches = []; }
  const branchName = (id) => state.branches.find((b) => b.id === id)?.name || id || '';

  el.innerHTML = `
    <div class="max-w-6xl mx-auto space-y-5">
      <header class="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 class="text-3xl font-black text-[#241a0d]">Señas</h1>
          <p class="text-[#7d6c5c] text-sm">Anticipos que dejan los clientes para reservar. Se usan como pago en el POS al elegir el cliente.</p>
        </div>
        <button id="sn-new" class="ing-btn-primary flex items-center gap-2"><span class="material-symbols-outlined text-base">savings</span> Nueva seña</button>
      </header>

      <div id="sn-cards" class="grid grid-cols-2 md:grid-cols-4 gap-3"></div>

      <div class="ing-card p-3 flex flex-wrap gap-3 items-end">
        <div>
          <label class="text-xs font-bold text-[#7d6c5c] uppercase block mb-1">Estado</label>
          <select id="sn-status" class="ing-input">
            <option value="active">Activas</option><option value="redeemed">Usadas</option><option value="cancelled">Devueltas</option><option value="">Todas</option>
          </select>
        </div>
        <div>
          <label class="text-xs font-bold text-[#7d6c5c] uppercase block mb-1">Sucursal</label>
          <select id="sn-branch" class="ing-input"><option value="">Todas</option>${state.branches.map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('')}</select>
        </div>
        <div class="flex-1 min-w-[220px]">
          <label class="text-xs font-bold text-[#7d6c5c] uppercase block mb-1">Buscar</label>
          <input id="sn-q" class="ing-input w-full" placeholder="Cliente, documento, N° de seña o nota…" />
        </div>
      </div>

      <div class="ing-card overflow-hidden">
        <table class="ing-table w-full">
          <thead><tr>
            <th>#</th><th>Fecha</th><th>Cliente</th><th class="text-right">Monto</th><th>Medio</th><th>Reserva</th><th>Sucursal</th><th>Estado</th><th></th>
          </tr></thead>
          <tbody id="sn-body"><tr><td colspan="9" class="text-center py-8 text-[#7d6c5c]">Cargando…</td></tr></tbody>
        </table>
      </div>
    </div>`;

  // Trae TODAS (hasta 1000) de la sucursal elegida y filtra estado/búsqueda en el cliente:
  // así las tarjetas de resumen siempre muestran el panorama completo.
  async function load() {
    try {
      state.rows = await Senas.list('', '', state.branch || '');
    } catch (err) {
      el.querySelector('#sn-body').innerHTML = `<tr><td colspan="9" class="text-center py-8 text-red-600">${esc(err.message || 'No se pudieron cargar las señas')}</td></tr>`;
      return;
    }
    render();
  }

  function render() {
    const all = state.rows;
    const active = all.filter((s) => s.status === 'active');
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const inMonth = (d) => d && new Date(d) >= monthStart;
    const cobradasMes = all.filter((s) => inMonth(s.createdAt));
    const usadasMes = all.filter((s) => s.status === 'redeemed' && inMonth(s.redeemedAt));
    const devueltoMes = all.filter((s) => (s.refundAmount || 0) > 0 && (inMonth(s.cancelledAt) || inMonth(s.redeemedAt)));
    const sum = (list, f) => list.reduce((n, s) => n + (Number(f(s)) || 0), 0);
    const card = (label, value, sub, cls = 'text-[#241a0d]') => `
      <div class="ing-card p-4">
        <div class="text-[10px] font-black uppercase text-[#7d6c5c]">${label}</div>
        <div class="text-2xl font-black mt-1 ${cls}">${value}</div>
        <div class="text-xs text-[#7d6c5c]">${sub}</div>
      </div>`;
    el.querySelector('#sn-cards').innerHTML =
      card('Plata retenida (activas)', money(sum(active, (s) => s.amount)), `${active.length} seña${active.length === 1 ? '' : 's'} sin usar`, 'text-indigo-700') +
      card('Cobradas este mes', money(sum(cobradasMes, (s) => s.amount)), `${cobradasMes.length} seña${cobradasMes.length === 1 ? '' : 's'}`) +
      card('Usadas este mes', money(sum(usadasMes, (s) => s.usedAmount ?? s.amount)), `${usadasMes.length} en ventas`, 'text-green-700') +
      card('Devuelto este mes', money(sum(devueltoMes, (s) => s.refundAmount)), 'cancelaciones y sobrantes', 'text-orange-600');

    const q = state.q.trim().toLowerCase();
    const rows = all.filter((s) => {
      if (state.status && s.status !== state.status) return false;
      if (!q) return true;
      const hay = `${s.number} ${s.customer?.name || ''} ${s.customer?.documentNumber || ''} ${s.note || ''}`.toLowerCase();
      return hay.includes(q);
    });

    const body = el.querySelector('#sn-body');
    if (!rows.length) { body.innerHTML = `<tr><td colspan="9" class="text-center py-10 text-[#7d6c5c]">No hay señas ${state.status ? STATUS[state.status].label.toLowerCase() + 's' : ''}${q ? ' que coincidan' : ''}.</td></tr>`; return; }
    body.innerHTML = rows.map((s) => {
      const st = STATUS[s.status] || { label: s.status, cls: 'bg-gray-100 text-gray-700' };
      let detail = '';
      if (s.status === 'redeemed') {
        detail = `<div class="text-[11px] text-[#7d6c5c]">Venta #${esc(s.redeemedSaleNumber ?? '?')} · ${esc(fmtDateTime(s.redeemedAt))}${(s.refundAmount || 0) > 0 ? `<br/>Sobrante devuelto ${money(s.refundAmount)} (${esc(s.refundMethodName || '')})` : ''}</div>`;
      } else if (s.status === 'cancelled') {
        detail = `<div class="text-[11px] text-[#7d6c5c]">${s.cancelledAt ? esc(fmtDateTime(s.cancelledAt)) + ' · ' : ''}${esc(s.refundMethodName || s.methodName || '')}</div>`;
      }
      return `<tr>
        <td class="font-mono font-bold">#${esc(s.number)}</td>
        <td class="text-xs whitespace-nowrap">${esc(fmtDateTime(s.createdAt))}</td>
        <td><div class="font-bold text-sm">${esc(s.customer?.name || '—')}</div><div class="text-[11px] text-[#7d6c5c]">${s.customer?.documentNumber ? 'Doc ' + esc(s.customer.documentNumber) : ''}${s.customer?.phone ? ' · ' + esc(s.customer.phone) : ''}</div></td>
        <td class="text-right font-black text-[#d82f1e] whitespace-nowrap">${money(s.amount)}</td>
        <td class="text-sm">${esc(s.methodName || '—')}</td>
        <td class="text-sm">${esc(s.note || '')}</td>
        <td class="text-sm">${esc(branchName(s.branchId))}</td>
        <td><span class="px-2 py-0.5 rounded-full text-[11px] font-bold ${st.cls}">${st.label}</span>${detail}</td>
        <td class="text-right whitespace-nowrap">
          <button data-print="${esc(s.id)}" title="Imprimir comprobante" class="p-1.5 hover:bg-[#fff1e6] rounded-full"><span class="material-symbols-outlined text-base text-[#7d6c5c]">print</span></button>
          ${s.status === 'active' ? `<button data-refund="${esc(s.id)}" class="text-xs font-bold text-red-600 hover:underline ml-1">Devolver</button>` : ''}
        </td>
      </tr>`;
    }).join('');

    body.querySelectorAll('[data-print]').forEach((b) => b.addEventListener('click', () => {
      const s = state.rows.find((x) => x.id === b.dataset.print);
      if (s) printSena(s, branchName(s.branchId));
    }));
    body.querySelectorAll('[data-refund]').forEach((b) => b.addEventListener('click', async () => {
      const s = state.rows.find((x) => x.id === b.dataset.refund);
      if (!s) return;
      const refund = await openRefundModal({
        title: `Devolver seña #${s.number}`,
        message: `Se cancela la seña de <b>${esc(s.customer?.name || 'cliente')}</b> y se le devuelve la plata. La dejó con: <b>${esc(s.methodName || '—')}</b>.`,
        amount: s.amount,
        defaultMethodId: s.methodId,
      });
      if (!refund) return;
      try {
        await Senas.cancel(s.id, refund);
        toast(`Seña #${s.number} devuelta (${money(s.amount)})${refund.affectsCash ? ' · salió de caja' : ''}`, 'success');
        load();
      } catch (err) { toast('No se pudo devolver: ' + (err.message || ''), 'error'); }
    }));
  }

  el.querySelector('#sn-status').addEventListener('change', (e) => { state.status = e.target.value; render(); });
  el.querySelector('#sn-branch')?.addEventListener('change', (e) => { state.branch = e.target.value; load(); });
  el.querySelector('#sn-q').addEventListener('input', (e) => { state.q = e.target.value; render(); });
  el.querySelector('#sn-new').addEventListener('click', async () => {
    const created = await openNewSenaModal();
    if (created) await load();
  });

  await load();
}
