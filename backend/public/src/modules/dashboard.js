// Dashboard — vista general con KPIs, gráficos y actividad reciente.
// Backend-first: los KPIs y agregaciones vienen de /api/metrics/dashboard
// (consolidado o por sucursal). El POS y la caja siguen offline aparte.

import { api, ApiError } from '../core/api.js';
import { money, fmtDate, fmtDateTime, monthKey, todayKey } from '../core/format.js';
import { activeBranchId, currentSession } from '../core/auth.js';
import { on, EV } from '../core/events.js';

const charts = new Map();       // canvasId -> Chart instance
let refreshTimer = null;
const state = { branch: activeBranchId() || '', branches: [] };

export async function mount(el) {
  state.branch = activeBranchId() || '';
  try { state.branches = await api('/auth/branches'); } catch { state.branches = []; }
  renderShell(el);
  wireBranchSelector(el);
  await refreshAll(el);
  const handler = () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { if (el.isConnected) refreshAll(el); }, 400);
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
    if (refreshTimer) clearTimeout(refreshTimer);
  };
}

function wireBranchSelector(el) {
  const sel = el.querySelector('#dash-branch');
  sel?.addEventListener('change', () => { state.branch = sel.value; refreshAll(el); });
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
      <div class="flex gap-2 items-center">
        <select id="dash-branch" class="ing-input !py-2 !w-auto text-sm font-bold">
          <option value="">Total (todas)</option>
          ${state.branches.map(b => `<option value="${b.id}" ${state.branch === b.id ? 'selected' : ''}>${b.name}</option>`).join('')}
        </select>
        <a href="#/pos" class="ing-btn-primary flex items-center gap-2"><span class="material-symbols-outlined text-base">point_of_sale</span> Vender</a>
        <a href="#/cash" class="ing-btn-secondary flex items-center gap-2"><span class="material-symbols-outlined text-base">account_balance_wallet</span> Caja</a>
      </div>
    </div>
    <div id="dash-offline" class="hidden mb-4 p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-sm font-bold">
      Sin conexión: los informes necesitan internet. El POS y la caja siguen funcionando normalmente.
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
  const branch = state.branch;
  const today = todayKey();
  const month = monthKey();
  const branchName = branch ? (state.branches.find(b => b.id === branch)?.name || '—') : 'Todas las sucursales';

  const greeting = el.querySelector('#dash-greeting');
  if (greeting) greeting.innerHTML = `Hola <b>${currentSession()?.user_name || 'usuario'}</b> · Vista de <b>${branchName}</b> · ${fmtDate(today)}`;
  const brName = el.querySelector('#dash-branch-name');
  if (brName) brName.textContent = branchName;

  let d;
  try {
    const qs = new URLSearchParams({ month, today });
    if (branch) qs.set('branchId', branch);
    d = await api(`/api/metrics/dashboard?${qs.toString()}`);
    el.querySelector('#dash-offline')?.classList.add('hidden');
  } catch (err) {
    el.querySelector('#dash-offline')?.classList.remove('hidden');
    return;
  }

  const todayDelta = pctDelta(d.today.total, d.yesterday.total);
  const monthDelta = pctDelta(d.month.total, d.prevMonth.total);
  const prevAvgTicket = d.prevMonth.count ? d.prevMonth.total / d.prevMonth.count : 0;
  const ticketDelta = pctDelta(d.month.avgTicket, prevAvgTicket);

  setKpi(el, 'kpi-today', money(d.today.total), `${d.today.count} ticket${d.today.count !== 1 ? 's' : ''} · ayer ${money(d.yesterday.total)}`, todayDelta);
  setKpi(el, 'kpi-month', money(d.month.total), `${d.month.count} ventas · ticket ${money(d.month.avgTicket)} (${fmtDeltaInline(ticketDelta)})`, monthDelta);
  setKpi(el, 'kpi-cash', money(d.cash.balance), `${d.cash.movements} movimientos`);
  setCardColor(el, 'kpi-cash', d.cash.balance >= 0 ? '#16a34a' : '#dc2626');
  setKpi(el, 'kpi-inv', money(d.inventory.valueCost), `${d.inventory.units} unidades · valor venta ${money(d.inventory.valueSale)}`);
  setKpi(el, 'kpi-stock', d.inventory.outOfStock, `${d.inventory.outOfStock} sin stock`);
  setKpi(el, 'kpi-checks', d.checks.count, `${money(d.checks.sum)} · ${d.checks.overdue} vencidos · ${d.checks.soon} esta semana`);
  setKpi(el, 'kpi-expenses', money(d.expensesMonth), `Devoluciones: ${money(d.returnsMonth)}`);
  setKpi(el, 'kpi-birthdays', d.birthdays, `cumpleaños este mes`);

  renderSalesChart(el, d.serie30 || []);
  renderMethodsChart(el, d.methods || []);
  renderTopProductsChart(el, d.topProducts || []);
  renderCategoryChart(el, d.byCategory || []);
  renderActivity(el, d.recent || []);
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

function renderSalesChart(el, serie30) {
  const canvas = el.querySelector('#chart-sales');
  if (!canvas) return;
  const labels = serie30.map(p => { const [, m, dd] = p.day.split('-'); return `${dd}/${m}`; });
  const data = serie30.map(p => Number((p.total || 0).toFixed(2)));
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

function renderMethodsChart(el, methods) {
  const canvas = el.querySelector('#chart-methods');
  if (!canvas) return;
  const labels = methods.map(m => m.methodName || m.methodId || '—');
  const data = methods.map(m => Number((m.amount || 0).toFixed(2)));
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

function renderTopProductsChart(el, topProducts) {
  const canvas = el.querySelector('#chart-top');
  if (!canvas) return;
  const labels = topProducts.map(p => { const n = p.name || ''; return n.length > 22 ? n.slice(0, 20) + '…' : n; });
  const data = topProducts.map(p => p.qty || 0);
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

function renderCategoryChart(el, byCategory) {
  const canvas = el.querySelector('#chart-cat');
  if (!canvas) return;
  const labels = byCategory.map(c => c.name);
  const data = byCategory.map(c => Number((c.total || 0).toFixed(2)));
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

function renderActivity(el, recent) {
  const brMap = Object.fromEntries(state.branches.map(b => [b.id, b.name]));
  const top = (recent || []).map(s => ({
    t: s.datetime, icon: 'shopping_cart', color: '#16a34a',
    title: `Venta #${s.number}`, sub: brMap[s.branchId] || '', amount: s.total,
  }));
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
