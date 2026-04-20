// Saldo — totales facturados/devueltos del día/mes/año con filtros y export.

import { getAll, get } from '../core/db.js';
import { money, fmtDateTime, todayKey, monthKey, yearKey } from '../core/format.js';
import { activeBranchId } from '../core/auth.js';
import { exportToXLSX } from '../core/xlsx.js';
import { toast } from '../core/notifications.js';
import { loadFilter, saveFilter } from '../core/filter-state.js';

const state = loadFilter('balance', {
  period: 'day',
  date: todayKey(),
  filters: { method: '', category: '', brand: '', supplier: '', minAmount: 0, maxAmount: 0, seller: '' },
});

export async function mount(el) { await render(el); }

async function render(el) {
  const branchId = activeBranchId();
  const [sales, returns, products, categories, brands, suppliers, employees, methodsCfg] = await Promise.all([
    getAll('sales'), getAll('returns'), getAll('products'), getAll('categories'),
    getAll('brands'), getAll('suppliers'), getAll('employees'), get('config', 'payment_methods'),
  ]);
  const methods = methodsCfg?.value || [];
  const productMap = Object.fromEntries(products.map(p => [p.id, p]));

  const f = state.filters;
  const inPeriod = (iso) => {
    if (state.period === 'day') return iso.startsWith(state.date);
    if (state.period === 'month') return iso.slice(0, 7) === state.date.slice(0, 7);
    if (state.period === 'year') return iso.slice(0, 4) === state.date.slice(0, 4);
    if (state.period === 'custom') {
      return iso.slice(0, 10) >= state.customFrom && iso.slice(0, 10) <= state.customTo;
    }
    return true;
  };

  const matchSale = (s) => {
    if (s.branch_id !== branchId) return false;
    if (!inPeriod(s.datetime)) return false;
    if (f.method && !s.payments?.some(p => p.method_id === f.method)) return false;
    if (f.seller && s.seller_id !== f.seller) return false;
    if (f.minAmount && s.total < f.minAmount) return false;
    if (f.maxAmount && s.total > f.maxAmount) return false;
    if (f.category || f.brand || f.supplier) {
      const ok = (s.items || []).some(it => {
        const p = productMap[it.product_id];
        if (!p) return false;
        if (f.category && p.category_id !== f.category) return false;
        if (f.brand && p.brand_id !== f.brand) return false;
        if (f.supplier && p.supplier_id !== f.supplier) return false;
        return true;
      });
      if (!ok) return false;
    }
    return true;
  };

  const filteredSales = sales.filter(matchSale);
  const filteredReturns = returns.filter(r => r.branch_id === branchId && inPeriod(r.datetime));

  const totalSales = filteredSales.reduce((s, x) => s + (x.total || 0), 0);
  const totalReturns = filteredReturns.reduce((s, x) => s + (Math.max(0, -x.difference) || 0), 0); // lo que se devuelve a favor cliente
  const netBalance = totalSales - totalReturns;
  const ticketPromedio = filteredSales.length ? totalSales / filteredSales.length : 0;

  // Breakdown por método
  const byMethod = {};
  for (const sale of filteredSales) {
    for (const p of (sale.payments || [])) {
      byMethod[p.method_id] = (byMethod[p.method_id] || 0) + (Number(p.amount) || 0);
    }
  }

  el.innerHTML = `
    <div class="mb-6 flex justify-between items-start gap-4">
      <div>
        <h1 class="text-3xl font-black text-[#241a0d]">Saldo</h1>
        <p class="text-sm text-[#7d6c5c] mt-1">Ventas, devoluciones y totales por período</p>
      </div>
      <button id="sb-export" class="ing-btn-secondary flex items-center gap-2">
        <span class="material-symbols-outlined text-base">download</span> Exportar XLSX
      </button>
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
          <select id="f-method" class="ing-input mt-1"><option value="">Todos</option>${methods.map(m => `<option value="${m.id}" ${f.method===m.id?'selected':''}>${m.name}</option>`).join('')}</select>
        </div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Categoría</label>
          <select id="f-cat" class="ing-input mt-1"><option value="">Todas</option>${categories.map(c => `<option value="${c.id}" ${f.category===c.id?'selected':''}>${c.name}</option>`).join('')}</select>
        </div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Marca</label>
          <select id="f-brand" class="ing-input mt-1"><option value="">Todas</option>${brands.map(b => `<option value="${b.id}" ${f.brand===b.id?'selected':''}>${b.name}</option>`).join('')}</select>
        </div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Proveedor</label>
          <select id="f-sup" class="ing-input mt-1"><option value="">Todos</option>${suppliers.map(s => `<option value="${s.id}" ${f.supplier===s.id?'selected':''}>${s.name}</option>`).join('')}</select>
        </div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Vendedor</label>
          <select id="f-seller" class="ing-input mt-1"><option value="">Todos</option>${employees.map(e => `<option value="${e.id}" ${f.seller===e.id?'selected':''}>${e.name} ${e.lastname||''}</option>`).join('')}</select>
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
            ${filteredSales.length ? filteredSales.sort((a,b) => b.datetime.localeCompare(a.datetime)).map(s => `
              <tr>
                <td class="font-mono font-bold">#${s.number}</td>
                <td class="text-xs">${fmtDateTime(s.datetime)}</td>
                <td class="text-sm">${s.customer_id ? 'Cliente' : 'Consumidor final'}</td>
                <td class="text-center">${s.items?.length || 0}</td>
                <td class="text-right font-bold text-[#d82f1e]">${money(s.total)}</td>
                <td class="text-xs">${(s.payments || []).map(p => methods.find(m => m.id === p.method_id)?.name || p.method_id).join(', ')}</td>
              </tr>
            `).join('') : `<tr><td colspan="6" class="text-center py-8 text-[#7d6c5c]">Sin ventas en el período</td></tr>`}
          </tbody>
        </table>
      </div>

      <div class="ing-card p-4 h-fit">
        <h3 class="font-black mb-3">Por medio de pago</h3>
        ${Object.keys(byMethod).length ? Object.entries(byMethod).sort((a,b) => b[1]-a[1]).map(([mId, amt]) => {
          const m = methods.find(x => x.id === mId);
          const pct = totalSales ? (amt / totalSales * 100) : 0;
          return `
            <div class="mb-3">
              <div class="flex justify-between text-sm mb-1"><span class="font-bold">${m?.name || mId}</span><span>${money(amt)} <span class="text-[#7d6c5c]">(${pct.toFixed(1)}%)</span></span></div>
              <div class="h-2 bg-[#fff1e6] rounded-full overflow-hidden"><div class="h-full bg-[#d82f1e]" style="width:${pct}%"></div></div>
            </div>
          `;
        }).join('') : '<div class="text-sm text-[#7d6c5c]">Sin datos</div>'}
      </div>
    </div>
  `;

  const R = () => { saveFilter('balance', state); render(el); };
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
  el.querySelector('#f-cat').addEventListener('change', ev => { f.category = ev.target.value; R(); });
  el.querySelector('#f-brand').addEventListener('change', ev => { f.brand = ev.target.value; R(); });
  el.querySelector('#f-sup').addEventListener('change', ev => { f.supplier = ev.target.value; R(); });
  el.querySelector('#f-seller').addEventListener('change', ev => { f.seller = ev.target.value; R(); });
  el.querySelector('#f-min').addEventListener('change', ev => { f.minAmount = Number(ev.target.value) || 0; R(); });
  el.querySelector('#f-max').addEventListener('change', ev => { f.maxAmount = Number(ev.target.value) || 0; R(); });

  el.querySelector('#sb-export').addEventListener('click', () => {
    const salesRows = filteredSales.map(s => ({
      Numero: s.number, Fecha: fmtDateTime(s.datetime), Items: s.items?.length || 0,
      Total: s.total,
      Medios: (s.payments || []).map(p => `${methods.find(m => m.id === p.method_id)?.name || p.method_id}: ${p.amount}`).join(' · '),
    }));
    const returnsRows = filteredReturns.map(r => ({
      Numero: r.number, Fecha: fmtDateTime(r.datetime), Devuelto: r.returned_total, Llevado: r.taken_total, Diferencia: r.difference, Vale: r.credit_note_code || '',
    }));
    const mediosRows = Object.entries(byMethod).map(([mId, amt]) => ({ Medio: methods.find(x => x.id === mId)?.name || mId, Monto: amt }));
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
