// Dashboard — vista general con KPIs, gráficos y actividad reciente.
// P-1 memo por {branch, month} · P-3 reutiliza instancias Chart con update('none').

import { getAll } from '../core/db.js';
import { money, fmtDate, fmtDateTime, monthKey, todayKey } from '../core/format.js';
import { activeBranchId, currentSession } from '../core/auth.js';
import { on, EV } from '../core/events.js';

const charts = new Map();       // canvasId -> Chart instance
const aggCache = new Map();     // `${branch}|${month}` -> { monthSales, byProduct, byCategory, monthTotal, monthCount }
let methodsCache = null;
let refreshTimer = null;

function invalidate() { aggCache.clear(); }

async function getMethods() {
  if (methodsCache) return methodsCache;
  const cfg = await (await import('../core/db.js')).get('config', 'payment_methods');
  methodsCache = cfg?.value || [];
  return methodsCache;
}

function monthAgg(branch, month, sales, products, categories) {
  const k = `${branch}|${month}`;
  if (aggCache.has(k)) return aggCache.get(k);
  const monthSales = sales.filter(s => s.branch_id === branch && s.datetime?.slice(0, 7) === month && s.status !== 'cancelled');
  const prMap = Object.fromEntries(products.map(p => [p.id, p]));
  const catMap = Object.fromEntries(categories.map(c => [c.id, c.name]));
  const byProduct = {};
  const byCategory = {};
  let monthTotal = 0;
  for (const s of monthSales) {
    monthTotal += Number(s.total) || 0;
    for (const it of (s.items || [])) {
      const pk = it.name || it.product_id;
      if (!byProduct[pk]) byProduct[pk] = { qty: 0, subtotal: 0 };
      byProduct[pk].qty += Number(it.qty) || 0;
      byProduct[pk].subtotal += Number(it.subtotal) || 0;
      const cid = prMap[it.product_id]?.category_id || '—';
      const cname = catMap[cid] || 'Sin categoría';
      byCategory[cname] = (byCategory[cname] || 0) + (Number(it.subtotal) || 0);
    }
  }
  const result = { monthSales, monthTotal, monthCount: monthSales.length, byProduct, byCategory };
  aggCache.set(k, result);
  return result;
}

export async function mount(el) {
  renderShell(el);
  await refreshAll(el);
  const handler = () => {
    invalidate();
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { if (el.isConnected) refreshAll(el); }, 60);
  };
  const offs = [
    on(EV.SALE_CONFIRMED, handler),
    on(EV.CASH_MOVED, handler),
    on(EV.STOCK_CHANGED, handler),
    on(EV.RETURN_CONFIRMED, handler),
    on(EV.BRANCH_CHANGED, handler),
  ];
  return () => {
    offs.forEach(f => f());
    charts.forEach(c => { try { c.destroy(); } catch {} });
    charts.clear();
    aggCache.clear();
    if (refreshTimer) clearTimeout(refreshTimer);
  };
}

function kpiCard(id, label, icon, color) {
  return `
    <div id="${id}" class="ing-card" data-color="${color}">
      <div class="flex justify-between items-start">
        <div class="flex-1 min-w-0">
          <div class="text-[0.625rem] font-black text-[#7d6c5c] uppercase tracking-[0.2em]">${label}</div>
          <div class="flex items-baseline gap-2 mt-2">
            <div class="text-3xl font-black truncate kpi-value" style="color:${color}">—</div>
            <span class="kpi-delta"></span>
          </div>
          <div class="text-xs text-[#7d6c5c] mt-1 truncate kpi-hint">Cargando…</div>
        </div>
        <span class="material-symbols-outlined text-3xl opacity-70 shrink-0 kpi-icon" style="color:${color}">${icon}</span>
      </div>
    </div>
  `;
}

function alertKpiCard(id, label, icon, href, color) {
  return `
    <a id="${id}" href="#${href}" class="ing-card block hover:shadow-lg hover:border-[#d82f1e] transition-all" data-color="${color}">
      <div class="flex justify-between items-start">
        <div class="flex-1 min-w-0">
          <div class="text-[0.625rem] font-black text-[#7d6c5c] uppercase tracking-[0.2em]">${label}</div>
          <div class="text-2xl font-black mt-2 truncate kpi-value" style="color:${color}">—</div>
          <div class="text-xs text-[#7d6c5c] mt-1 truncate kpi-hint">Cargando…</div>
        </div>
        <span class="material-symbols-outlined text-2xl opacity-70 shrink-0 kpi-icon" style="color:${color}">${icon}</span>
      </div>
    </a>
  `;
}

function quickLink(href, icon, label) {
  return `
    <a href="#${href}" class="flex flex-col items-center justify-center gap-1 p-3 rounded-xl bg-[#fff8f4] hover:bg-[#fff1e6] border border-[#fff1e6] hover:border-[#d82f1e] transition-all text-center">
      <span class="material-symbols-outlined text-[#d82f1e] text-2xl">${icon}</span>
      <span class="text-xs font-bold text-[#241a0d]">${label}</span>
    </a>
  `;
}

function renderShell(el) {
  const session = currentSession();
  el.innerHTML = `
    <div class="mb-6 flex justify-between items-end">
      <div>
        <h1 class="text-3xl font-black text-[#241a0d]">Panel principal</h1>
        <p class="text-sm text-[#7d6c5c] mt-1" id="dash-greeting">Hola <b>${session?.user_name || 'usuario'}</b></p>
      </div>
      <div class="flex gap-2">
        <a href="#/pos" class="ing-btn-primary flex items-center gap-2"><span class="material-symbols-outlined text-base">point_of_sale</span> Vender</a>
        <a href="#/cash" class="ing-btn-secondary flex items-center gap-2"><span class="material-symbols-outlined text-base">account_balance_wallet</span> Caja</a>
      </div>
    </div>

    <div class="grid grid-cols-4 gap-4 mb-5">
      ${kpiCard('kpi-today', 'Ventas de hoy', 'trending_up', '#d82f1e')}
      ${kpiCard('kpi-month', 'Ventas del mes', 'calendar_month', '#f97316')}
      ${kpiCard('kpi-cash', 'Saldo de caja', 'account_balance_wallet', '#16a34a')}
      ${kpiCard('kpi-inv', 'Inventario (costo)', 'inventory_2', '#0ea5e9')}
    </div>

    <div class="grid grid-cols-4 gap-4 mb-6">
      ${alertKpiCard('kpi-stock', 'Stock crítico', 'warning', '/inventory', '#f59e0b')}
      ${alertKpiCard('kpi-checks', 'Cheques pendientes', 'receipt_long', '/checks', '#dc2626')}
      ${alertKpiCard('kpi-expenses', 'Gastos del mes', 'shopping_bag', '/cash', '#7c3aed')}
      ${alertKpiCard('kpi-birthdays', 'Cumpleaños del mes', 'cake', '/crm', '#ec4899')}
    </div>

    <div class="grid grid-cols-3 gap-5 mb-5">
      <div class="ing-card col-span-2">
        <div class="flex justify-between items-center mb-3">
          <h2 class="font-black text-lg text-[#241a0d]">Ventas · últimos 30 días</h2>
          <span class="text-xs font-bold text-[#7d6c5c]" id="dash-branch-name">—</span>
        </div>
        <div style="position:relative;height:280px"><canvas id="chart-sales"></canvas></div>
      </div>
      <div class="ing-card">
        <h2 class="font-black text-lg text-[#241a0d] mb-3">Medios de pago · mes</h2>
        <div style="position:relative;height:280px"><canvas id="chart-methods"></canvas></div>
      </div>
    </div>

    <div class="grid grid-cols-2 gap-5 mb-5">
      <div class="ing-card">
        <h2 class="font-black text-lg text-[#241a0d] mb-3">Top productos del mes</h2>
        <div style="position:relative;height:280px"><canvas id="chart-top"></canvas></div>
      </div>
      <div class="ing-card">
        <h2 class="font-black text-lg text-[#241a0d] mb-3">Ventas por categoría · mes</h2>
        <div style="position:relative;height:280px"><canvas id="chart-cat"></canvas></div>
      </div>
    </div>

    <div class="grid grid-cols-3 gap-5">
      <div class="ing-card col-span-2">
        <h2 class="font-black text-lg text-[#241a0d] mb-3">Actividad reciente</h2>
        <div id="activity-list"></div>
      </div>
      <div class="ing-card">
        <h2 class="font-black text-lg text-[#241a0d] mb-3">Accesos rápidos</h2>
        <div class="grid grid-cols-2 gap-2">
          ${quickLink('/inventory', 'inventory_2', 'Inventario')}
          ${quickLink('/crm', 'groups', 'Clientes')}
          ${quickLink('/returns', 'assignment_return', 'Devoluciones')}
          ${quickLink('/tasks', 'checklist', 'Tareas')}
          ${quickLink('/calendar', 'calendar_month', 'Calendario')}
          ${quickLink('/reports', 'summarize', 'Reportes')}
          ${quickLink('/balance', 'balance', 'Saldo')}
          ${quickLink('/profits', 'paid', 'Ganancias')}
        </div>
      </div>
    </div>
  `;
}

function setKpi(el, id, value, hint, delta = null) {
  const card = el.querySelector(`#${id}`);
  if (!card) return;
  const valNode = card.querySelector('.kpi-value');
  const hintNode = card.querySelector('.kpi-hint');
  const deltaNode = card.querySelector('.kpi-delta');
  if (valNode) valNode.textContent = value;
  if (hintNode) hintNode.textContent = hint;
  if (deltaNode) {
    if (delta != null && isFinite(delta)) {
      const up = delta >= 0;
      const cls = up ? 'text-green-700 bg-green-100' : 'text-red-700 bg-red-100';
      const arrow = up ? 'trending_up' : 'trending_down';
      deltaNode.innerHTML = `<span class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-black ${cls}"><span class="material-symbols-outlined" style="font-size:12px">${arrow}</span>${Math.abs(delta).toFixed(1)}%</span>`;
    } else if (delta === Infinity) {
      deltaNode.innerHTML = `<span class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-black text-green-700 bg-green-100">nuevo</span>`;
    } else {
      deltaNode.innerHTML = '';
    }
  }
}

function setCardColor(el, id, color) {
  const card = el.querySelector(`#${id}`);
  if (!card) return;
  card.dataset.color = color;
  const val = card.querySelector('.kpi-value');
  const icon = card.querySelector('.kpi-icon');
  if (val) val.style.color = color;
  if (icon) icon.style.color = color;
}

function pctDelta(cur, prev) {
  if (!prev) return cur > 0 ? Infinity : null;
  return ((cur - prev) / prev) * 100;
}

function fmtDeltaInline(d) {
  if (d == null) return 'sin referencia';
  if (!isFinite(d)) return 'sin dato previo';
  const arrow = d >= 0 ? '↑' : '↓';
  return `${arrow} ${Math.abs(d).toFixed(1)}%`;
}

async function refreshAll(el) {
  if (!el || !el.isConnected) return;

  const [sales, returns, products, stocks, cash, customers, checks, employees, expenses, categories, branches] = await Promise.all([
    getAll('sales'), getAll('returns'), getAll('products'), getAll('stock'),
    getAll('cash_movements'), getAll('customers'), getAll('checks'),
    getAll('employees'), getAll('expenses'), getAll('categories'), getAll('branches'),
  ]);

  const branch = activeBranchId();
  const today = todayKey();
  const month = monthKey();
  const branchName = branches.find(b => b.id === branch)?.name || '—';

  const greeting = el.querySelector('#dash-greeting');
  if (greeting) greeting.innerHTML = `Hola <b>${currentSession()?.user_name || 'usuario'}</b> · Vista de <b>${branchName}</b> · ${fmtDate(today)}`;
  const brName = el.querySelector('#dash-branch-name');
  if (brName) brName.textContent = branchName;

  const salesBr = sales.filter(s => s.branch_id === branch && s.status !== 'cancelled');
  const todaySales = salesBr.filter(s => s.datetime?.slice(0, 10) === today);
  const agg = monthAgg(branch, month, sales, products, categories);

  const todayTotal = todaySales.reduce((s, x) => s + (Number(x.total) || 0), 0);
  const monthTotal = agg.monthTotal;
  const monthCount = agg.monthCount;
  const avgTicket = monthCount ? monthTotal / monthCount : 0;

  const yesterdayKey = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); })();
  const prevMonthStr = (() => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return d.toISOString().slice(0, 7); })();
  const yesterdayTotal = salesBr.filter(s => s.datetime?.slice(0, 10) === yesterdayKey).reduce((s, x) => s + (Number(x.total) || 0), 0);
  const prevAgg = monthAgg(branch, prevMonthStr, sales, products, categories);
  const prevMonthTotal = prevAgg.monthTotal;
  const prevAvgTicket = prevAgg.monthCount ? prevMonthTotal / prevAgg.monthCount : 0;
  const todayDelta = pctDelta(todayTotal, yesterdayTotal);
  const monthDelta = pctDelta(monthTotal, prevMonthTotal);
  const ticketDelta = pctDelta(avgTicket, prevAvgTicket);

  const cashBr = cash.filter(m => m.branch_id === branch).sort((a, b) => a.datetime.localeCompare(b.datetime));
  const cashBalance = cashBr.reduce((s, m) => s + (Number(m.amount_in) || 0) - (Number(m.amount_out) || 0), 0);

  let invValueCost = 0, invValueSale = 0, invUnits = 0, lowStockCount = 0, outOfStock = 0;
  for (const p of products) {
    const qty = stocks.filter(s => s.product_id === p.id).reduce((t, s) => t + (s.qty || 0), 0);
    invUnits += qty;
    invValueCost += qty * (Number(p.cost) || 0);
    invValueSale += qty * (Number(p.price) || 0);
    const qtyBr = stocks.find(s => s.product_id === p.id && s.branch_id === branch)?.qty || 0;
    const min = Number(p.min_stock) || 0;
    if (qtyBr === 0) outOfStock++;
    else if (min > 0 && qtyBr <= min) lowStockCount++;
  }

  const checksPending = checks.filter(c => c.status === 'pending');
  const checksPendingSum = checksPending.reduce((s, c) => s + (Number(c.amount) || 0), 0);
  const checksOverdue = checksPending.filter(c => c.due_at && c.due_at < today).length;
  const checksSoon = checksPending.filter(c => {
    if (!c.due_at || c.due_at < today) return false;
    const diff = (new Date(c.due_at) - new Date(today)) / (1000 * 60 * 60 * 24);
    return diff <= 7;
  }).length;

  const monthExpenses = expenses.filter(e => e.branch_id === branch && e.datetime?.slice(0, 7) === month)
    .reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const monthReturns = returns.filter(r => r.branch_id === branch && r.datetime?.slice(0, 7) === month);
  const monthReturnsTotal = monthReturns.reduce((s, r) => s + (Number(r.returned_total) || 0), 0);

  const mm = String(new Date().getMonth() + 1).padStart(2, '0');
  const birthdaysThisMonth = customers.filter(c => c.birthday?.slice(5, 7) === mm);
  const empActiveBr = employees.filter(e => e.active && e.branch_id === branch).length;

  setKpi(el, 'kpi-today', money(todayTotal), `${todaySales.length} ticket${todaySales.length !== 1 ? 's' : ''} · ayer ${money(yesterdayTotal)}`, todayDelta);
  setKpi(el, 'kpi-month', money(monthTotal), `${monthCount} ventas · ticket ${money(avgTicket)} (${fmtDeltaInline(ticketDelta)})`, monthDelta);
  setKpi(el, 'kpi-cash', money(cashBalance), `${cashBr.length} movimientos`);
  setCardColor(el, 'kpi-cash', cashBalance >= 0 ? '#16a34a' : '#dc2626');
  setKpi(el, 'kpi-inv', money(invValueCost), `${invUnits} unidades · valor venta ${money(invValueSale)}`);
  setKpi(el, 'kpi-stock', lowStockCount, `${outOfStock} sin stock`);
  setKpi(el, 'kpi-checks', checksPending.length, `${money(checksPendingSum)} · ${checksOverdue} vencidos · ${checksSoon} esta semana`);
  setKpi(el, 'kpi-expenses', money(monthExpenses), `Devoluciones: ${money(monthReturnsTotal)}`);
  setKpi(el, 'kpi-birthdays', birthdaysThisMonth.length, `${empActiveBr} empleados activos`);

  renderSalesChart(el, salesBr);
  await renderMethodsChart(el, agg.monthSales);
  renderTopProductsChart(el, agg);
  renderCategoryChart(el, agg);
  renderActivity(el, salesBr, returns.filter(r => r.branch_id === branch), customers, employees);
}

function upsertChart(canvas, config) {
  if (!canvas || !window.Chart) return null;
  const id = canvas.id;
  if (charts.has(id)) {
    const c = charts.get(id);
    c.data = config.data;
    if (config.options) c.options = config.options;
    c.update('none');
    return c;
  }
  const c = new window.Chart(canvas.getContext('2d'), config);
  charts.set(id, c);
  return c;
}

function renderSalesChart(el, salesBr) {
  const canvas = el.querySelector('#chart-sales');
  if (!canvas) return;
  const days = 30;
  const labels = [];
  const data = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    labels.push(`${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`);
    const tot = salesBr.filter(s => s.datetime?.slice(0, 10) === key).reduce((s, x) => s + (Number(x.total) || 0), 0);
    data.push(Number(tot.toFixed(2)));
  }
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, 280);
  gradient.addColorStop(0, 'rgba(216, 47, 30, 0.35)');
  gradient.addColorStop(1, 'rgba(216, 47, 30, 0.02)');
  upsertChart(canvas, {
    type: 'line',
    data: { labels, datasets: [{
      label: 'Ventas', data,
      borderColor: '#d82f1e',
      backgroundColor: gradient,
      borderWidth: 2.5, tension: 0.35, fill: true,
      pointRadius: 0, pointHoverRadius: 5, pointHoverBackgroundColor: '#d82f1e',
    }]},
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => '$ ' + Number(ctx.parsed.y).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) } },
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 0 } },
        y: { grid: { color: '#fff1e6' }, ticks: { font: { size: 10 }, callback: v => '$ ' + (v >= 1000 ? (v / 1000).toFixed(0) + 'k' : v) } },
      },
    },
  });
}

async function renderMethodsChart(el, monthSales) {
  const canvas = el.querySelector('#chart-methods');
  if (!canvas) return;
  const methods = await getMethods();
  const mMap = Object.fromEntries(methods.map(m => [m.id, m.name]));
  const byMethod = {};
  for (const s of monthSales) {
    for (const p of (s.payments || [])) {
      const key = mMap[p.method_id] || p.method_id || '—';
      byMethod[key] = (byMethod[key] || 0) + (Number(p.amount) || 0);
    }
  }
  const labels = Object.keys(byMethod);
  const data = Object.values(byMethod);
  const palette = ['#d82f1e', '#f97316', '#eab308', '#16a34a', '#0ea5e9', '#8b5cf6', '#ec4899', '#64748b'];
  upsertChart(canvas, {
    type: 'doughnut',
    data: {
      labels: labels.length ? labels : ['Sin datos'],
      datasets: [{ data: data.length ? data : [1], backgroundColor: labels.length ? palette.slice(0, labels.length) : ['#e3ceba'], borderWidth: 2, borderColor: '#fff' }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '65%',
      plugins: {
        legend: { display: labels.length > 0, position: 'bottom', labels: { font: { size: 11 }, padding: 10, boxWidth: 12 } },
        tooltip: { enabled: labels.length > 0, callbacks: { label: (ctx) => `${ctx.label}: $ ${Number(ctx.parsed).toLocaleString('es-AR', { minimumFractionDigits: 2 })}` } },
      },
    },
  });
}

function renderTopProductsChart(el, agg) {
  const canvas = el.querySelector('#chart-top');
  if (!canvas) return;
  const top = Object.entries(agg.byProduct).sort((a, b) => b[1].qty - a[1].qty).slice(0, 8);
  const labels = top.map(([n]) => n.length > 22 ? n.slice(0, 20) + '…' : n);
  const data = top.map(([, v]) => v.qty);
  upsertChart(canvas, {
    type: 'bar',
    data: {
      labels: labels.length ? labels : ['Sin ventas'],
      datasets: [{ label: 'Unidades', data: data.length ? data : [0], backgroundColor: '#d82f1e', borderRadius: 6 }],
    },
    options: {
      indexAxis: 'y',
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: '#fff1e6' }, ticks: { font: { size: 10 }, precision: 0 } },
        y: { grid: { display: false }, ticks: { font: { size: 10 } } },
      },
    },
  });
}

function renderCategoryChart(el, agg) {
  const canvas = el.querySelector('#chart-cat');
  if (!canvas) return;
  const entries = Object.entries(agg.byCategory).sort((a, b) => b[1] - a[1]);
  const labels = entries.map(([k]) => k);
  const data = entries.map(([, v]) => Number(v.toFixed(2)));
  const palette = ['#d82f1e', '#f97316', '#eab308', '#16a34a', '#0ea5e9', '#8b5cf6', '#ec4899', '#64748b', '#14b8a6', '#a855f7'];
  upsertChart(canvas, {
    type: 'pie',
    data: {
      labels: labels.length ? labels : ['Sin ventas'],
      datasets: [{ data: data.length ? data : [1], backgroundColor: labels.length ? palette.slice(0, labels.length) : ['#e3ceba'], borderWidth: 2, borderColor: '#fff' }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: labels.length > 0, position: 'right', labels: { font: { size: 11 }, padding: 8, boxWidth: 12 } },
        tooltip: { enabled: labels.length > 0, callbacks: { label: (ctx) => `${ctx.label}: $ ${Number(ctx.parsed).toLocaleString('es-AR', { minimumFractionDigits: 2 })}` } },
      },
    },
  });
}

function renderActivity(el, salesBr, returnsBr, customers, employees) {
  const cuMap = Object.fromEntries(customers.map(c => [c.id, `${c.name} ${c.lastname || ''}`.trim()]));
  const emMap = Object.fromEntries(employees.map(e => [e.id, `${e.name} ${e.lastname || ''}`.trim()]));
  const feed = [];
  for (const s of salesBr) feed.push({ t: s.datetime, kind: 'sale', icon: 'shopping_cart', color: '#16a34a', title: `Venta #${s.number}`, sub: `${cuMap[s.customer_id] || 'Sin cliente'} · ${emMap[s.seller_id] || ''}`, amount: s.total });
  for (const r of returnsBr) feed.push({ t: r.datetime, kind: 'return', icon: 'assignment_return', color: '#dc2626', title: `Devolución #${r.number}`, sub: `${cuMap[r.customer_id] || 'Sin cliente'}${r.credit_note_code ? ' · Vale ' + r.credit_note_code : ''}`, amount: -Math.abs(r.returned_total || 0) });
  feed.sort((a, b) => (b.t || '').localeCompare(a.t || ''));
  const top = feed.slice(0, 10);
  const container = el.querySelector('#activity-list');
  if (!container) return;
  if (!top.length) {
    container.innerHTML = '<div class="text-center text-[#7d6c5c] text-sm py-6">Sin actividad aún</div>';
    return;
  }
  container.innerHTML = `
    <div class="space-y-2">
      ${top.map(f => `
        <div class="flex items-center gap-3 p-2 rounded-lg hover:bg-[#fff8f4]">
          <div class="w-9 h-9 rounded-full flex items-center justify-center shrink-0" style="background:${f.color}15">
            <span class="material-symbols-outlined text-base" style="color:${f.color}">${f.icon}</span>
          </div>
          <div class="flex-1 min-w-0">
            <div class="font-bold text-sm text-[#241a0d] truncate">${f.title}</div>
            <div class="text-xs text-[#7d6c5c] truncate">${f.sub}</div>
          </div>
          <div class="text-right shrink-0">
            <div class="font-black text-sm" style="color:${f.amount >= 0 ? '#16a34a' : '#dc2626'}">${f.amount >= 0 ? '+' : ''}${money(f.amount)}</div>
            <div class="text-[10px] text-[#7d6c5c]">${fmtDateTime(f.t)}</div>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}
