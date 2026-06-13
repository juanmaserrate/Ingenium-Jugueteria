// Saldo — totales facturados/devueltos del día/mes/año con filtros y export.

import { api } from '../core/api.js';
import { money, fmtDateTime, todayKey } from '../core/format.js';
import { activeBranchId } from '../core/auth.js';
import { exportToXLSX } from '../core/xlsx.js';
import { toast } from '../core/notifications.js';
import { loadFilter, saveFilter } from '../core/filter-state.js';

const state = loadFilter('balance', {
  period: 'day',
  date: todayKey(),
  filters: { method: '', minAmount: 0, maxAmount: 0 },
});
let branches = [];
let branchSel = activeBranchId() || '';

const AR = '-03:00';
// Devuelve {from,to} ISO absolutos según el período seleccionado (en hora Argentina).
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
  } else { // custom
    fromD = new Date(`${state.customFrom || todayKey()}T00:00:00.000${AR}`);
    toD = new Date(new Date(`${state.customTo || todayKey()}T00:00:00.000${AR}`).getTime() + 86400000);
  }
  return { from: fromD.toISOString(), to: toD.toISOString() };
}

export async function mount(el) {
  try { branches = await api('/auth/branches'); } catch { branches = []; }
  branchSel = activeBranchId() || '';
  await render(el);
}

async function render(el) {
  const f = state.filters;
  const { from, to } = rangeISO();
  let data;
  try {
    const qs = new URLSearchParams({ from, to });
    if (branchSel) qs.set('branchId', branchSel);
    data = await api(`/api/metrics/balance?${qs.toString()}`);
  } catch {
    el.innerHTML = `<div class="mb-6"><h1 class="text-3xl font-black text-[#241a0d]">Saldo</h1></div>
      <div class="ing-card p-6 text-center"><span class="material-symbols-outlined text-4xl text-amber-500">cloud_off</span>
      <p class="mt-2 font-bold">Sin conexión</p><p class="text-sm text-[#7d6c5c]">Los informes necesitan internet. El POS y la caja funcionan normalmente.</p></div>`;
    return;
  }

  // Filtros locales sobre la lista que devuelve el backend (medio de pago + monto)
  let filteredSales = data.sales || [];
  if (f.method) filteredSales = filteredSales.filter(s => (s.payments || []).some(p => p.methodName === f.method));
  if (f.minAmount) filteredSales = filteredSales.filter(s => s.total >= f.minAmount);
  if (f.maxAmount) filteredSales = filteredSales.filter(s => s.total <= f.maxAmount);
  const filteredReturns = data.returns || [];

  const usingLocalFilter = !!(f.method || f.minAmount || f.maxAmount);
  const totalSales = usingLocalFilter ? filteredSales.reduce((s, x) => s + (x.total || 0), 0) : data.facturado;
  const totalReturns = data.devuelto;
  const netBalance = totalSales - totalReturns;
  const ticketPromedio = filteredSales.length ? totalSales / filteredSales.length : 0;
  const methodNames = [...new Set((data.methods || []).map(m => m.methodName))];
  const byMethod = {};
  for (const m of (data.methods || [])) byMethod[m.methodName] = m.amount;

  el.innerHTML = `
    <div class="mb-6 flex justify-between items-start gap-4">
      <div>
        <h1 class="text-3xl font-black text-[#241a0d]">Saldo</h1>
        <p class="text-sm text-[#7d6c5c] mt-1">Ventas, devoluciones y totales por período</p>
      </div>
      <div class="flex gap-2 items-center">
        <select id="sb-branch" class="ing-input">
          <option value="">Total (todas)</option>
          ${branches.map(b => `<option value="${b.id}" ${branchSel===b.id?'selected':''}>${b.name}</option>`).join('')}
        </select>
        <button id="sb-export" class="ing-btn-secondary flex items-center gap-2">
          <span class="material-symbols-outlined text-base">download</span> XLSX
        </button>
      </div>
    </div>

    <div class="ing-card p-4 mb-4">
      <div class="flex flex-wrap gap-3 items-end">
        <div>
          <label class="text-xs font-bold text-[#7d6c5c] uppercase">Período</label>
          <div class="flex gap-1 mt-1">
            ${['day','month','year','custom'].map(p => `<button data-period="${p}" class="px-3 py-1.5 text-xs font-bold rounded-lg ${state.period===p?'bg-[#d82f1e] text-white':'bg-[#fff1e6] text-[#7d6c5c]'}">${{day:'Día',month:'Mes',year:'Año',custom:'Rango'}[p]}</button>`).join('')}
          </div>
        </div>
        ${state.period === 'custom' ? `
          <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Desde</label><input id="sb-from" type="date" value="${state.customFrom || todayKey()}" class="ing-input mt-1" /></div>
          <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Hasta</label><input id="sb-to" type="date" value="${state.customTo || todayKey()}" class="ing-input mt-1" /></div>
        ` : `
          <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Fecha</label><input id="sb-date" type="${state.period === 'year' ? 'number' : state.period === 'month' ? 'month' : 'date'}" value="${state.period === 'year' ? state.date.slice(0,4) : state.period === 'month' ? state.date.slice(0,7) : state.date}" class="ing-input mt-1" /></div>
        `}
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Medio</label>
          <select id="f-method" class="ing-input mt-1"><option value="">Todos</option>${methodNames.map(m => `<option value="${m}" ${f.method===m?'selected':''}>${m}</option>`).join('')}</select>
        </div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Monto desde</label><input id="f-min" type="number" value="${f.minAmount||0}" class="ing-input mt-1 w-28" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Hasta</label><input id="f-max" type="number" value="${f.maxAmount||0}" class="ing-input mt-1 w-28" /></div>
      </div>
    </div>

    <div class="grid grid-cols-4 gap-3 mb-5">
      <div class="ing-card p-4">
        <div class="text-[10px] font-black uppercase text-[#7d6c5c]">Facturado</div>
        <div class="text-3xl font-black text-[#d82f1e] mt-1">${money(totalSales)}</div>
        <div class="text-xs text-[#7d6c5c]">${filteredSales.length} ventas</div>
      </div>
      <div class="ing-card p-4">
        <div class="text-[10px] font-black uppercase text-[#7d6c5c]">Devuelto</div>
        <div class="text-3xl font-black text-orange-600 mt-1">${money(totalReturns)}</div>
        <div class="text-xs text-[#7d6c5c]">${filteredReturns.length} operaciones</div>
      </div>
      <div class="ing-card p-4">
        <div class="text-[10px] font-black uppercase text-[#7d6c5c]">Saldo neto</div>
        <div class="text-3xl font-black text-green-700 mt-1">${money(netBalance)}</div>
      </div>
      <div class="ing-card p-4">
        <div class="text-[10px] font-black uppercase text-[#7d6c5c]">Ticket promedio</div>
        <div class="text-3xl font-black text-[#241a0d] mt-1">${money(ticketPromedio)}</div>
      </div>
    </div>

    <div class="grid grid-cols-[1fr_340px] gap-4">
      <div class="ing-card overflow-hidden">
        <div class="px-4 py-3 bg-[#fff8f4] text-sm font-bold">Ventas del período</div>
        <table class="ing-table w-full">
          <thead><tr><th>#</th><th>Fecha</th><th>Cliente</th><th>Items</th><th class="text-right">Total</th><th>Medios</th></tr></thead>
          <tbody>
            ${filteredSales.length ? filteredSales.map(s => `
              <tr>
                <td class="font-mono font-bold">#${s.number}</td>
                <td class="text-xs">${fmtDateTime(s.datetime)}</td>
                <td class="text-sm">${branchName(s.branchId)}</td>
                <td class="text-center">—</td>
                <td class="text-right font-bold text-[#d82f1e]">${money(s.total)}</td>
                <td class="text-xs">${(s.payments || []).map(p => p.methodName).join(', ')}</td>
              </tr>
            `).join('') : `<tr><td colspan="6" class="text-center py-8 text-[#7d6c5c]">Sin ventas en el período</td></tr>`}
          </tbody>
        </table>
      </div>

      <div class="ing-card p-4 h-fit">
        <h3 class="font-black mb-3">Por medio de pago</h3>
        ${Object.keys(byMethod).length ? Object.entries(byMethod).sort((a,b) => b[1]-a[1]).map(([name, amt]) => {
          const pct = data.facturado ? (amt / data.facturado * 100) : 0;
          return `
            <div class="mb-3">
              <div class="flex justify-between text-sm mb-1"><span class="font-bold">${name}</span><span>${money(amt)} <span class="text-[#7d6c5c]">(${pct.toFixed(1)}%)</span></span></div>
              <div class="h-2 bg-[#fff1e6] rounded-full overflow-hidden"><div class="h-full bg-[#d82f1e]" style="width:${pct}%"></div></div>
            </div>
          `;
        }).join('') : '<div class="text-sm text-[#7d6c5c]">Sin datos</div>'}
      </div>
    </div>
  `;

  const R = () => { saveFilter('balance', state); render(el); };
  el.querySelector('#sb-branch').addEventListener('change', ev => { branchSel = ev.target.value; render(el); });
  el.querySelectorAll('[data-period]').forEach(b => b.addEventListener('click', () => {
    state.period = b.dataset.period;
    if (state.period === 'custom' && !state.customFrom) { state.customFrom = todayKey(); state.customTo = todayKey(); }
    R();
  }));
  const d = el.querySelector('#sb-date');
  if (d) d.addEventListener('change', (ev) => { state.date = state.period === 'year' ? `${ev.target.value}-01-01` : state.period === 'month' ? `${ev.target.value}-01` : ev.target.value; R(); });
  const from = el.querySelector('#sb-from'); if (from) from.addEventListener('change', ev => { state.customFrom = ev.target.value; R(); });
  const to = el.querySelector('#sb-to'); if (to) to.addEventListener('change', ev => { state.customTo = ev.target.value; R(); });

  el.querySelector('#f-method').addEventListener('change', ev => { f.method = ev.target.value; R(); });
  el.querySelector('#f-min').addEventListener('change', ev => { f.minAmount = Number(ev.target.value) || 0; R(); });
  el.querySelector('#f-max').addEventListener('change', ev => { f.maxAmount = Number(ev.target.value) || 0; R(); });

  el.querySelector('#sb-export').addEventListener('click', () => {
    const salesRows = filteredSales.map(s => ({
      Numero: s.number, Fecha: fmtDateTime(s.datetime), Sucursal: branchName(s.branchId),
      Total: s.total,
      Medios: (s.payments || []).map(p => `${p.methodName}: ${p.amount}`).join(' · '),
    }));
    const returnsRows = filteredReturns.map(r => ({
      Numero: r.number, Fecha: fmtDateTime(r.datetime), Devuelto: r.returnedTotal, Llevado: r.takenTotal, Diferencia: r.difference,
    }));
    const mediosRows = Object.entries(byMethod).map(([name, amt]) => ({ Medio: name, Monto: amt }));
    exportToXLSX({
      filename: `saldo_${state.period}_${state.date}.xlsx`,
      sheets: [
        { name: 'Ventas', rows: salesRows },
        { name: 'Devoluciones', rows: returnsRows },
        { name: 'Por medio', rows: mediosRows },
      ],
    });
    toast('Exportado', 'success');
  });
}

function branchName(id) {
  return branches.find(b => b.id === id)?.name || '—';
}
