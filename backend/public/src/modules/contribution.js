// Contribución Marginal — ranking por producto, categoría, marca, proveedor.
// CM = Ventas - Costo (sin asignar gastos fijos).

import { getAll } from '../core/db.js';
import { money, monthKey } from '../core/format.js';
import { activeBranchId } from '../core/auth.js';
import { exportToXLSX } from '../core/xlsx.js';
import { toast } from '../core/notifications.js';
import { loadFilter, saveFilter } from '../core/filter-state.js';

const state = loadFilter('contribution', {
  view: 'product',  // product | category | brand | supplier
  month: monthKey(),
  top: 50,
});

export async function mount(el) { await render(el); }

async function render(el) {
  const branchId = activeBranchId();
  const [sales, products, categories, brands, suppliers] = await Promise.all([
    getAll('sales'), getAll('products'), getAll('categories'), getAll('brands'), getAll('suppliers'),
  ]);
  const inMonth = (d) => d.slice(0, 7) === state.month;
  const monthSales = sales.filter(s => s.branch_id === branchId && inMonth(s.datetime));

  const productMap = Object.fromEntries(products.map(p => [p.id, p]));
  const catMap = Object.fromEntries(categories.map(c => [c.id, c.name]));
  const brandMap = Object.fromEntries(brands.map(b => [b.id, b.name]));
  const supMap = Object.fromEntries(suppliers.map(s => [s.id, s.name]));

  // Agregar por producto
  const agg = {};
  for (const sale of monthSales) {
    for (const it of (sale.items || [])) {
      const p = productMap[it.product_id];
      if (!p) continue;
      const key = keyFor(state.view, p);
      if (!agg[key]) agg[key] = { label: labelFor(state.view, p, catMap, brandMap, supMap), sales: 0, cost: 0, qty: 0, n: 0 };
      const sub = Number(it.subtotal) || 0;
      const cost = (Number(it.cost_snapshot) || 0) * (Number(it.qty) || 0);
      agg[key].sales += sub;
      agg[key].cost += cost;
      agg[key].qty += Number(it.qty) || 0;
      agg[key].n += 1;
    }
  }
  const totalSales = Object.values(agg).reduce((s, v) => s + v.sales, 0);
  const totalMargin = Object.values(agg).reduce((s, v) => s + (v.sales - v.cost), 0);

  const rows = Object.entries(agg).map(([k, v]) => ({
    key: k,
    label: v.label,
    sales: v.sales,
    cost: v.cost,
    cm: v.sales - v.cost,
    cmPct: v.sales ? ((v.sales - v.cost) / v.sales) * 100 : 0,
    shareOfSales: totalSales ? (v.sales / totalSales) * 100 : 0,
    shareOfCM: totalMargin ? ((v.sales - v.cost) / totalMargin) * 100 : 0,
    qty: v.qty,
  })).sort((a, b) => b.cm - a.cm);

  const topRows = rows.slice(0, state.top);

  el.innerHTML = `
    <div class="mb-6 flex justify-between items-start gap-4">
      <div>
        <h1 class="text-3xl font-black text-[#241a0d]">Contribución Marginal</h1>
        <p class="text-sm text-[#7d6c5c] mt-1">Ranking de aporte · Ventas − COGS</p>
      </div>
      <div class="flex items-center gap-2">
        <input type="month" value="${state.month}" id="cm-month" class="ing-input" />
        <select id="cm-top" class="ing-input">
          ${[20, 50, 100, 500].map(n => `<option value="${n}" ${n===state.top?'selected':''}>Top ${n}</option>`).join('')}
        </select>
        <button id="cm-export" class="ing-btn-secondary flex items-center gap-2"><span class="material-symbols-outlined text-base">download</span> XLSX</button>
      </div>
    </div>

    <div class="flex gap-2 mb-4">
      ${['product','category','brand','supplier'].map(v => `<button data-view="${v}" class="px-4 py-2 rounded-lg font-bold text-sm ${state.view===v?'bg-[#d82f1e] text-white':'bg-[#fff1e6] text-[#7d6c5c]'}">${{product:'Producto',category:'Categoría',brand:'Marca',supplier:'Proveedor'}[v]}</button>`).join('')}
    </div>

    <div class="grid grid-cols-3 gap-3 mb-5">
      <div class="ing-card p-4"><div class="text-[10px] font-black uppercase text-[#7d6c5c]">Ventas totales</div><div class="text-2xl font-black text-[#d82f1e]">${money(totalSales)}</div></div>
      <div class="ing-card p-4"><div class="text-[10px] font-black uppercase text-[#7d6c5c]">Contribución total</div><div class="text-2xl font-black text-green-700">${money(totalMargin)}</div></div>
      <div class="ing-card p-4"><div class="text-[10px] font-black uppercase text-[#7d6c5c]">Margen promedio</div><div class="text-2xl font-black text-[#241a0d]">${totalSales ? ((totalMargin / totalSales) * 100).toFixed(1) : '0.0'}%</div></div>
    </div>

    <div class="ing-card overflow-hidden">
      <table class="ing-table w-full">
        <thead>
          <tr>
            <th>#</th><th>${{product:'Producto',category:'Categoría',brand:'Marca',supplier:'Proveedor'}[state.view]}</th>
            <th class="text-right">Unidades</th>
            <th class="text-right">Ventas</th>
            <th class="text-right">Costo</th>
            <th class="text-right">CM $</th>
            <th class="text-right">CM %</th>
            <th class="text-right">% del total</th>
          </tr>
        </thead>
        <tbody>
          ${topRows.length ? topRows.map((r, i) => `
            <tr>
              <td class="font-mono text-xs text-[#7d6c5c]">${i+1}</td>
              <td class="font-bold">${r.label}</td>
              <td class="text-right">${r.qty}</td>
              <td class="text-right font-bold">${money(r.sales)}</td>
              <td class="text-right text-[#7d6c5c]">${money(r.cost)}</td>
              <td class="text-right font-bold text-green-700">${money(r.cm)}</td>
              <td class="text-right">${r.cmPct.toFixed(1)}%</td>
              <td class="text-right">${r.shareOfSales.toFixed(1)}%</td>
            </tr>
          `).join('') : `<tr><td colspan="8" class="text-center py-8 text-[#7d6c5c]">Sin ventas en el período</td></tr>`}
        </tbody>
      </table>
    </div>
  `;

  el.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => { state.view = b.dataset.view; saveFilter('contribution', state); render(el); }));
  el.querySelector('#cm-month').addEventListener('change', (ev) => { state.month = ev.target.value; saveFilter('contribution', state); render(el); });
  el.querySelector('#cm-top').addEventListener('change', (ev) => { state.top = Number(ev.target.value) || 50; saveFilter('contribution', state); render(el); });
  el.querySelector('#cm-export').addEventListener('click', () => {
    exportToXLSX({
      filename: `contribucion_${state.view}_${state.month}.xlsx`,
      sheets: [{
        name: 'CM',
        rows: rows.map((r, i) => ({
          Posicion: i+1, [state.view]: r.label,
          Unidades: r.qty, Ventas: r.sales, Costo: r.cost, CM: r.cm,
          CM_pct: Number(r.cmPct.toFixed(2)), ShareVentas: Number(r.shareOfSales.toFixed(2)),
        })),
      }],
    });
    toast('Exportado', 'success');
  });
}

function keyFor(view, p) {
  if (view === 'product') return p.id;
  if (view === 'category') return p.category_id || '—';
  if (view === 'brand') return p.brand_id || '—';
  if (view === 'supplier') return p.supplier_id || '—';
  return '—';
}
function labelFor(view, p, catMap, brandMap, supMap) {
  if (view === 'product') return p.name + ' ' + (p.code ? `(${p.code})` : '');
  if (view === 'category') return catMap[p.category_id] || 'Sin categoría';
  if (view === 'brand') return brandMap[p.brand_id] || 'Sin marca';
  if (view === 'supplier') return supMap[p.supplier_id] || 'Sin proveedor';
  return '—';
}
