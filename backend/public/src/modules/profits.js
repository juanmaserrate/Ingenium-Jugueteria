// Ganancias — P&L mensual: ventas - devoluciones - gastos - cheques.
// Snapshots mensuales + comparativo mes anterior.

import { getAll, put } from '../core/db.js';
import { money, monthKey } from '../core/format.js';
import { activeBranchId } from '../core/auth.js';
import { exportToXLSX } from '../core/xlsx.js';
import { toast } from '../core/notifications.js';
import * as Audit from '../core/audit.js';

const state = {
  month: monthKey(),
};

export async function mount(el) { await render(el); }

async function compute(month, branchId) {
  const [sales, returns, expenses, products, checks] = await Promise.all([
    getAll('sales'), getAll('returns'), getAll('expenses'), getAll('products'), getAll('checks'),
  ]);
  const inMonth = (d) => (d || '').slice(0, 7) === month;
  const productMap = Object.fromEntries(products.map(p => [p.id, p]));

  const monthSales = sales.filter(s => s.branch_id === branchId && inMonth(s.datetime));
  const monthReturns = returns.filter(r => r.branch_id === branchId && inMonth(r.datetime));
  const monthExp = expenses.filter(e => e.branch_id === branchId && inMonth(e.datetime));
  const monthChecks = checks.filter(c => c.branch_id === branchId && c.due_date && inMonth(c.due_date));

  const grossSales = monthSales.reduce((s, sl) => s + (sl.total || 0), 0);

  // Lo facturado neto: ventas + delta de devoluciones (positivo suma, negativo resta)
  const returnsInvoicedDelta = monthReturns.reduce((s, r) => {
    const d = r.invoiced_delta != null ? r.invoiced_delta : r.difference;
    return s + (Number(d) || 0);
  }, 0);
  const netInvoiced = grossSales + returnsInvoicedDelta;
  // Monto que sale de la empresa por devoluciones puras o a favor del cliente
  const returnedValue = monthReturns.reduce((s, r) => {
    const d = r.invoiced_delta != null ? r.invoiced_delta : r.difference;
    return s + Math.max(0, -(Number(d) || 0));
  }, 0);

  const cogs = monthSales.reduce((acc, sale) => {
    return acc + (sale.items || []).reduce((a, it) => a + (Number(it.cost_snapshot) || 0) * (Number(it.qty) || 0), 0);
  }, 0);

  const grossProfit = grossSales - cogs;
  const totalExpenses = monthExp.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const totalChecks = monthChecks.reduce((s, c) => s + (Number(c.amount) || 0), 0);
  const netProfit = grossProfit - totalExpenses - totalChecks - returnedValue;

  const byCat = {};
  for (const sale of monthSales) {
    for (const it of (sale.items || [])) {
      const p = productMap[it.product_id];
      const catId = p?.category_id || '—';
      const sub = Number(it.subtotal) || 0;
      const cost = (Number(it.cost_snapshot) || 0) * (Number(it.qty) || 0);
      if (!byCat[catId]) byCat[catId] = { sales: 0, cost: 0, qty: 0 };
      byCat[catId].sales += sub;
      byCat[catId].cost += cost;
      byCat[catId].qty += Number(it.qty) || 0;
    }
  }

  const byDay = {};
  for (const s of monthSales) {
    const d = s.datetime.slice(0, 10);
    byDay[d] = (byDay[d] || 0) + (s.total || 0);
  }

  return { grossSales, netInvoiced, returnedValue, cogs, grossProfit, totalExpenses, totalChecks, netProfit, monthSales, monthReturns, monthExp, monthChecks, byCat, byDay };
}

async function render(el) {
  const branchId = activeBranchId();
  const pnl = await compute(state.month, branchId);

  const prevDate = new Date(state.month + '-01'); prevDate.setMonth(prevDate.getMonth() - 1);
  const prevMonth = monthKey(prevDate);
  const prev = await compute(prevMonth, branchId);

  const categories = await getAll('categories');
  const catMap = Object.fromEntries(categories.map(c => [c.id, c.name]));

  const delta = (cur, prv) => {
    if (!prv) return null;
    const d = ((cur - prv) / prv) * 100;
    return isFinite(d) ? d : null;
  };

  el.innerHTML = `
    <div class="mb-6 flex justify-between items-start gap-4">
      <div>
        <h1 class="text-3xl font-black text-[#241a0d]">Ganancias</h1>
        <p class="text-sm text-[#7d6c5c] mt-1">P&amp;L mensual · Comparativo vs. mes anterior</p>
      </div>
      <div class="flex items-center gap-2">
        <input type="month" value="${state.month}" id="pm-month" class="ing-input" />
        <button id="pm-snapshot" class="ing-btn-secondary flex items-center gap-2"><span class="material-symbols-outlined text-base">save</span> Guardar snapshot</button>
        <button id="pm-export" class="ing-btn-secondary flex items-center gap-2"><span class="material-symbols-outlined text-base">download</span> XLSX</button>
      </div>
    </div>

    <div class="grid grid-cols-4 gap-3 mb-5">
      ${kpi('Ventas brutas', money(pnl.grossSales), delta(pnl.grossSales, prev.grossSales), 'point_of_sale')}
      ${kpi('COGS', money(pnl.cogs), delta(pnl.cogs, prev.cogs), 'inventory_2', true)}
      ${kpi('Ganancia bruta', money(pnl.grossProfit), delta(pnl.grossProfit, prev.grossProfit), 'trending_up')}
      ${kpi('Ganancia neta', money(pnl.netProfit), delta(pnl.netProfit, prev.netProfit), 'savings')}
    </div>

    <div class="grid grid-cols-[1fr_360px] gap-5">
      <div class="ing-card p-5">
        <h3 class="font-black text-lg mb-4">Estado de resultados · ${state.month}</h3>
        <div class="space-y-2">
          ${row('Ventas del mes', pnl.grossSales)}
          ${row('Ajuste por devoluciones', pnl.netInvoiced - pnl.grossSales, false, 'text-[#7d6c5c]')}
          ${rowBold('Facturado neto', pnl.netInvoiced)}
          ${row('Costo de mercadería vendida', -pnl.cogs, false, 'text-red-600')}
          ${rowBold('Ganancia bruta', pnl.grossProfit, 'text-green-700')}
          <div class="py-1"></div>
          ${row('Gastos operativos', -pnl.totalExpenses, false, 'text-red-600')}
          ${row('Devoluciones a clientes', -pnl.returnedValue, false, 'text-red-600')}
          ${row('Cheques (vencen en el mes)', -pnl.totalChecks, false, 'text-red-600')}
          <div class="border-t border-[#fff1e6] pt-3">
            ${rowBold('GANANCIA NETA', pnl.netProfit, pnl.netProfit >= 0 ? 'text-green-700' : 'text-red-600', 'text-xl')}
          </div>
        </div>
      </div>

      <div class="space-y-4">
        <div class="ing-card p-4">
          <h3 class="font-black mb-3">Por categoría</h3>
          ${Object.keys(pnl.byCat).length ? Object.entries(pnl.byCat).sort((a,b) => b[1].sales - a[1].sales).map(([cId, v]) => {
            const margin = v.sales ? ((v.sales - v.cost) / v.sales) * 100 : 0;
            const width = pnl.grossSales ? (v.sales / pnl.grossSales * 100) : 0;
            return `
              <div class="mb-3">
                <div class="flex justify-between text-sm mb-1">
                  <span class="font-bold">${catMap[cId] || cId}</span>
                  <span class="text-xs">${money(v.sales)} · <span class="text-green-700">${margin.toFixed(1)}%</span></span>
                </div>
                <div class="h-1.5 bg-[#fff1e6] rounded-full"><div class="h-full bg-[#d82f1e] rounded-full" style="width:${width}%"></div></div>
              </div>
            `;
          }).join('') : '<div class="text-sm text-[#7d6c5c]">Sin datos</div>'}
        </div>

        <div class="ing-card p-4">
          <h3 class="font-black mb-3">Comparación</h3>
          <div class="text-sm space-y-1">
            <div class="flex justify-between"><span class="text-[#7d6c5c]">Mes actual</span><span class="font-bold">${money(pnl.netProfit)}</span></div>
            <div class="flex justify-between"><span class="text-[#7d6c5c]">Mes anterior (${prevMonth})</span><span class="font-bold">${money(prev.netProfit)}</span></div>
            ${(function() {
              const d = delta(pnl.netProfit, prev.netProfit);
              return d === null ? '' : `<div class="flex justify-between pt-2 border-t border-[#fff1e6]"><span class="font-bold">Variación</span><span class="font-bold ${d >= 0 ? 'text-green-700' : 'text-red-600'}">${d >= 0 ? '+' : ''}${d.toFixed(1)}%</span></div>`;
            })()}
          </div>
        </div>
      </div>
    </div>
  `;

  el.querySelector('#pm-month').addEventListener('change', (ev) => { state.month = ev.target.value; render(el); });
  el.querySelector('#pm-snapshot').addEventListener('click', async () => { await saveSnapshot(state.month, branchId, pnl); toast('Snapshot guardado', 'success'); });
  el.querySelector('#pm-export').addEventListener('click', () => exportPnl(pnl, state.month, catMap));
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

async function saveSnapshot(month, branchId, pnl) {
  const id = `${month}_${branchId}`;
  const rec = {
    id, month, branch_id: branchId, snapshot_at: new Date().toISOString(),
    gross_sales: pnl.grossSales, net_invoiced: pnl.netInvoiced,
    cogs: pnl.cogs, gross_profit: pnl.grossProfit, expenses: pnl.totalExpenses,
    checks: pnl.totalChecks, returns: pnl.returnedValue, net_profit: pnl.netProfit,
  };
  await put('monthly_pnl', rec);
  await Audit.log({ action: 'snapshot', entity: 'ganancias', entity_id: id, after: rec, description: `Snapshot ${month}` });
}

function exportPnl(pnl, month, catMap) {
  const pnlRows = [
    { Concepto: 'Ventas del mes', Monto: pnl.grossSales },
    { Concepto: 'Ajuste devoluciones', Monto: pnl.netInvoiced - pnl.grossSales },
    { Concepto: 'Facturado neto', Monto: pnl.netInvoiced },
    { Concepto: 'COGS', Monto: -pnl.cogs },
    { Concepto: 'Ganancia bruta', Monto: pnl.grossProfit },
    { Concepto: 'Gastos', Monto: -pnl.totalExpenses },
    { Concepto: 'Devoluciones', Monto: -pnl.returnedValue },
    { Concepto: 'Cheques', Monto: -pnl.totalChecks },
    { Concepto: 'GANANCIA NETA', Monto: pnl.netProfit },
  ];
  const catRows = Object.entries(pnl.byCat).map(([c, v]) => ({
    Categoria: catMap[c] || c, Ventas: v.sales, Costo: v.cost, Margen: v.sales - v.cost, Unidades: v.qty,
  }));
  const dayRows = Object.entries(pnl.byDay).sort((a,b) => a[0].localeCompare(b[0])).map(([d, total]) => ({ Fecha: d, Ventas: total }));
  exportToXLSX({
    filename: `ganancias_${month}.xlsx`,
    sheets: [
      { name: 'P&L', rows: pnlRows },
      { name: 'Por categoría', rows: catRows },
      { name: 'Por día', rows: dayRows },
    ],
  });
  toast('Exportado', 'success');
}
