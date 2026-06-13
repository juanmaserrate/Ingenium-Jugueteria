// Ganancias — P&L mensual desde el backend (consolidado o por sucursal).
// ventas - COGS - gastos - cheques - devoluciones a cliente.

import { api } from '../core/api.js';
import { money, monthKey } from '../core/format.js';
import { activeBranchId } from '../core/auth.js';
import { exportToXLSX } from '../core/xlsx.js';
import { toast } from '../core/notifications.js';

const state = { month: monthKey() };
let branches = [];
let branchSel = activeBranchId() || '';

export async function mount(el) {
  try { branches = await api('/auth/branches'); } catch { branches = []; }
  branchSel = activeBranchId() || '';
  await render(el);
}

async function fetchPnl(month) {
  const qs = new URLSearchParams({ month });
  if (branchSel) qs.set('branchId', branchSel);
  return api(`/api/metrics/profits?${qs.toString()}`);
}

async function render(el) {
  let pnl, prev;
  try {
    pnl = await fetchPnl(state.month);
    const prevDate = new Date(state.month + '-01T12:00:00-03:00'); prevDate.setMonth(prevDate.getMonth() - 1);
    const prevMonth = monthKey(prevDate);
    prev = await fetchPnl(prevMonth).catch(() => null);
    el.dataset.prevMonth = prevMonth;
  } catch {
    el.innerHTML = `<div class="mb-6"><h1 class="text-3xl font-black text-[#241a0d]">Ganancias</h1></div>
      <div class="ing-card p-6 text-center"><span class="material-symbols-outlined text-4xl text-amber-500">cloud_off</span>
      <p class="mt-2 font-bold">Sin conexión</p><p class="text-sm text-[#7d6c5c]">Los informes necesitan internet. El POS y la caja funcionan normalmente.</p></div>`;
    return;
  }
  const prevMonth = el.dataset.prevMonth;
  const delta = (cur, prv) => { if (!prv) return null; const d = ((cur - prv) / prv) * 100; return isFinite(d) ? d : null; };

  el.innerHTML = `
    <div class="mb-6 flex justify-between items-start gap-4">
      <div>
        <h1 class="text-3xl font-black text-[#241a0d]">Ganancias</h1>
        <p class="text-sm text-[#7d6c5c] mt-1">P&amp;L mensual · Comparativo vs. mes anterior</p>
      </div>
      <div class="flex items-center gap-2">
        <select id="pm-branch" class="ing-input">
          <option value="">Total (todas)</option>
          ${branches.map(b => `<option value="${b.id}" ${branchSel===b.id?'selected':''}>${b.name}</option>`).join('')}
        </select>
        <input type="month" value="${state.month}" id="pm-month" class="ing-input" />
        <button id="pm-export" class="ing-btn-secondary flex items-center gap-2"><span class="material-symbols-outlined text-base">download</span> XLSX</button>
      </div>
    </div>

    <div class="grid grid-cols-4 gap-3 mb-5">
      ${kpi('Ventas brutas', money(pnl.ventasBrutas), delta(pnl.ventasBrutas, prev?.ventasBrutas), 'point_of_sale')}
      ${kpi('COGS', money(pnl.cogs), delta(pnl.cogs, prev?.cogs), 'inventory_2', true)}
      ${kpi('Ganancia bruta', money(pnl.gananciaBruta), delta(pnl.gananciaBruta, prev?.gananciaBruta), 'trending_up')}
      ${kpi('Ganancia neta', money(pnl.gananciaNeta), delta(pnl.gananciaNeta, prev?.gananciaNeta), 'savings')}
    </div>

    <div class="grid grid-cols-[1fr_360px] gap-5">
      <div class="ing-card p-5">
        <h3 class="font-black text-lg mb-4">Estado de resultados · ${state.month}</h3>
        <div class="space-y-2">
          ${rowBold('Ventas del mes', pnl.ventasBrutas)}
          ${row('Costo de mercadería vendida', -pnl.cogs, false, 'text-red-600')}
          ${rowBold('Ganancia bruta', pnl.gananciaBruta, 'text-green-700')}
          <div class="py-1"></div>
          ${row('Gastos operativos', -pnl.gastos, false, 'text-red-600')}
          ${row('Devoluciones a clientes', -pnl.devueltoCliente, false, 'text-red-600')}
          ${row('Cheques (vencen en el mes)', -pnl.cheques, false, 'text-red-600')}
          <div class="border-t border-[#fff1e6] pt-3">
            ${rowBold('GANANCIA NETA', pnl.gananciaNeta, pnl.gananciaNeta >= 0 ? 'text-green-700' : 'text-red-600', 'text-xl')}
          </div>
        </div>
      </div>

      <div class="space-y-4">
        <div class="ing-card p-4">
          <h3 class="font-black mb-3">Por categoría</h3>
          ${(pnl.byCategory || []).length ? pnl.byCategory.map(v => {
            const width = pnl.ventasBrutas ? (v.sales / pnl.ventasBrutas * 100) : 0;
            return `
              <div class="mb-3">
                <div class="flex justify-between text-sm mb-1">
                  <span class="font-bold">${v.name}</span>
                  <span class="text-xs">${money(v.sales)} · <span class="text-green-700">${(v.marginPct||0).toFixed(1)}%</span></span>
                </div>
                <div class="h-1.5 bg-[#fff1e6] rounded-full"><div class="h-full bg-[#d82f1e] rounded-full" style="width:${width}%"></div></div>
              </div>`;
          }).join('') : '<div class="text-sm text-[#7d6c5c]">Sin datos</div>'}
        </div>

        <div class="ing-card p-4">
          <h3 class="font-black mb-3">Comparación</h3>
          <div class="text-sm space-y-1">
            <div class="flex justify-between"><span class="text-[#7d6c5c]">Mes actual</span><span class="font-bold">${money(pnl.gananciaNeta)}</span></div>
            <div class="flex justify-between"><span class="text-[#7d6c5c]">Mes anterior (${prevMonth})</span><span class="font-bold">${money(prev?.gananciaNeta || 0)}</span></div>
            ${(function() {
              const d = delta(pnl.gananciaNeta, prev?.gananciaNeta);
              return d === null ? '' : `<div class="flex justify-between pt-2 border-t border-[#fff1e6]"><span class="font-bold">Variación</span><span class="font-bold ${d >= 0 ? 'text-green-700' : 'text-red-600'}">${d >= 0 ? '+' : ''}${d.toFixed(1)}%</span></div>`;
            })()}
          </div>
        </div>
      </div>
    </div>
  `;

  el.querySelector('#pm-branch').addEventListener('change', ev => { branchSel = ev.target.value; render(el); });
  el.querySelector('#pm-month').addEventListener('change', (ev) => { state.month = ev.target.value; render(el); });
  el.querySelector('#pm-export').addEventListener('click', () => exportPnl(pnl, state.month));
}

function kpi(label, value, deltaPct, icon, inverse = false) {
  const pos = deltaPct !== null && (inverse ? deltaPct < 0 : deltaPct >= 0);
  return `
    <div class="ing-card p-4">
      <div class="flex items-start justify-between">
        <div>
          <div class="text-[10px] font-black uppercase text-[#7d6c5c]">${label}</div>
          <div class="text-2xl font-black text-[#241a0d] mt-1">${value}</div>
        </div>
        <span class="material-symbols-outlined text-[#d82f1e]">${icon}</span>
      </div>
      ${deltaPct !== null ? `<div class="text-xs mt-2 ${pos ? 'text-green-700' : 'text-red-600'} font-bold">${deltaPct >= 0 ? '▲' : '▼'} ${Math.abs(deltaPct).toFixed(1)}% vs mes ant.</div>` : ''}
    </div>
  `;
}

function row(label, amount, bold = false, extraClass = '') {
  return `<div class="flex justify-between text-sm ${bold?'font-bold':''} ${extraClass}"><span>${label}</span><span>${money(amount)}</span></div>`;
}
function rowBold(label, amount, color = 'text-[#241a0d]', size = '') {
  return `<div class="flex justify-between font-bold ${color} ${size}"><span>${label}</span><span>${money(amount)}</span></div>`;
}

function exportPnl(pnl, month) {
  const pnlRows = [
    { Concepto: 'Ventas del mes', Monto: pnl.ventasBrutas },
    { Concepto: 'COGS', Monto: -pnl.cogs },
    { Concepto: 'Ganancia bruta', Monto: pnl.gananciaBruta },
    { Concepto: 'Gastos', Monto: -pnl.gastos },
    { Concepto: 'Devoluciones', Monto: -pnl.devueltoCliente },
    { Concepto: 'Cheques', Monto: -pnl.cheques },
    { Concepto: 'GANANCIA NETA', Monto: pnl.gananciaNeta },
  ];
  const catRows = (pnl.byCategory || []).map(v => ({
    Categoria: v.name, Ventas: v.sales, Costo: v.cost, Margen: v.sales - v.cost, Unidades: v.qty,
  }));
  exportToXLSX({
    filename: `ganancias_${month}.xlsx`,
    sheets: [
      { name: 'P&L', rows: pnlRows },
      { name: 'Por categoría', rows: catRows },
    ],
  });
  toast('Exportado', 'success');
}
