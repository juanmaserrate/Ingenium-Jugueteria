// Reportes — exportaciones XLSX de todos los dominios.

import { getAll } from '../core/db.js';
import { money, fmtDateTime, fmtDate, monthKey, hoursBetween, hoursDecimal } from '../core/format.js';
import { activeBranchId } from '../core/auth.js';
import { exportToXLSX } from '../core/xlsx.js';
import { toast } from '../core/notifications.js';

const REPORTS = [
  { id: 'sales', name: 'Ventas', desc: 'Todas las ventas con detalle', icon: 'trending_up' },
  { id: 'returns', name: 'Devoluciones', desc: 'Devoluciones y vales emitidos', icon: 'assignment_return' },
  { id: 'cash', name: 'Caja', desc: 'Movimientos de efectivo de la sucursal', icon: 'account_balance_wallet' },
  { id: 'expenses', name: 'Gastos', desc: 'Gastos por categoría', icon: 'shopping_bag' },
  { id: 'pnl', name: 'P&L mensuales', desc: 'Todos los snapshots guardados', icon: 'paid' },
  { id: 'inventory', name: 'Inventario', desc: 'Productos + stock valorizado', icon: 'inventory_2' },
  { id: 'transfers', name: 'Transferencias', desc: 'Movimientos entre sucursales', icon: 'swap_horiz' },
  { id: 'stock-by-cat', name: 'Stock por categoría', desc: 'Resumen agrupado', icon: 'category' },
  { id: 'checks', name: 'Cheques', desc: 'Todos los cheques con estado', icon: 'receipt_long' },
  { id: 'employees', name: 'Empleados + horas', desc: 'Liquidación mensual estimada', icon: 'badge' },
  { id: 'audit', name: 'Auditoría', desc: 'Acciones por usuario y entidad', icon: 'history' },
  { id: 'customers', name: 'Clientes', desc: 'Directorio + métricas', icon: 'groups' },
  { id: 'comparison', name: 'Comparativa', desc: 'Mes actual vs anterior · Lomas vs Banfield', icon: 'compare_arrows' },
];

export async function mount(el) {
  el.innerHTML = `
    <div class="mb-6">
      <h1 class="text-3xl font-black text-[#241a0d]">Reportes</h1>
      <p class="text-sm text-[#7d6c5c] mt-1">Exportaciones XLSX · Click para descargar</p>
    </div>
    <div class="grid grid-cols-3 gap-4">
      ${REPORTS.map(r => `
        <button data-rep="${r.id}" class="ing-card text-left hover:shadow-lg hover:border-[#d82f1e] transition-all">
          <span class="material-symbols-outlined text-[#d82f1e] text-3xl">${r.icon}</span>
          <h3 class="font-black text-lg mt-3">${r.name}</h3>
          <p class="text-xs text-[#7d6c5c] mt-1">${r.desc}</p>
          <div class="mt-3 text-xs font-bold text-[#d82f1e] flex items-center gap-1"><span class="material-symbols-outlined text-sm">download</span> Descargar</div>
        </button>
      `).join('')}
    </div>
  `;
  el.querySelectorAll('[data-rep]').forEach(b => b.addEventListener('click', () => runReport(b.dataset.rep)));
}

async function runReport(id) {
  try {
    switch (id) {
      case 'sales': await repSales(); break;
      case 'returns': await repReturns(); break;
      case 'cash': await repCash(); break;
      case 'expenses': await repExpenses(); break;
      case 'pnl': await repPnl(); break;
      case 'inventory': await repInventory(); break;
      case 'transfers': await repTransfers(); break;
      case 'stock-by-cat': await repStockByCat(); break;
      case 'checks': await repChecks(); break;
      case 'employees': await repEmployees(); break;
      case 'audit': await repAudit(); break;
      case 'customers': await repCustomers(); break;
      case 'comparison': await repComparison(); break;
    }
    toast('Exportado', 'success');
  } catch (err) {
    toast('Error: ' + err.message, 'error');
  }
}

async function repSales() {
  const [sales, customers, employees, products, methodsCfg] = await Promise.all([
    getAll('sales'), getAll('customers'), getAll('employees'), getAll('products'), (await import('../core/db.js')).get('config', 'payment_methods'),
  ]);
  const cuMap = Object.fromEntries(customers.map(c => [c.id, `${c.name} ${c.lastname||''}`]));
  const emMap = Object.fromEntries(employees.map(e => [e.id, `${e.name} ${e.lastname||''}`]));
  const prMap = Object.fromEntries(products.map(p => [p.id, p]));
  const methods = methodsCfg?.value || [];
  const header = sales.map(s => ({
    Numero: s.number, Fecha: fmtDateTime(s.datetime), Sucursal: s.branch_id,
    Cliente: cuMap[s.customer_id] || '', Vendedor: emMap[s.seller_id] || '',
    Items: s.items?.length || 0, Total: s.total,
    Pagos: (s.payments || []).map(p => `${methods.find(m => m.id === p.method_id)?.name || p.method_id}: ${p.amount}`).join(' · '),
  }));
  const details = [];
  for (const s of sales) {
    for (const it of (s.items || [])) {
      details.push({
        Numero: s.number, Fecha: fmtDate(s.datetime), Producto: it.name, Codigo: it.code,
        Categoria: prMap[it.product_id]?.category_id || '', Cantidad: it.qty,
        Precio: it.unit_price, Costo: it.cost_snapshot, Subtotal: it.subtotal,
      });
    }
  }
  exportToXLSX({ filename: 'reporte_ventas.xlsx', sheets: [
    { name: 'Ventas', rows: header }, { name: 'Detalle items', rows: details },
  ]});
}

async function repReturns() {
  const [returns, customers, creditNotes] = await Promise.all([getAll('returns'), getAll('customers'), getAll('credit_notes')]);
  const cuMap = Object.fromEntries(customers.map(c => [c.id, `${c.name} ${c.lastname||''}`]));
  const rows = returns.map(r => ({
    Numero: r.number, Fecha: fmtDateTime(r.datetime), Cliente: cuMap[r.customer_id] || '',
    Devuelve: r.returned_total, Lleva: r.taken_total, Diferencia: r.difference,
    Vale: r.credit_note_code || '', Motivo: r.reason || '',
  }));
  const vales = creditNotes.map(v => ({
    Codigo: v.code, Cliente: cuMap[v.customer_id] || '', Monto: v.amount,
    Emitido: fmtDate(v.issued_at), Vence: fmtDate(v.expires_at),
    Canjeado: v.redeemed_at ? fmtDate(v.redeemed_at) : '',
  }));
  exportToXLSX({ filename: 'reporte_devoluciones.xlsx', sheets: [
    { name: 'Devoluciones', rows }, { name: 'Vales', rows: vales },
  ]});
}

async function repCash() {
  const all = await getAll('cash_movements');
  const br = activeBranchId();
  const rows = all.filter(m => m.branch_id === br).sort((a,b) => b.datetime.localeCompare(a.datetime))
    .map(m => ({ Fecha: fmtDateTime(m.datetime), Tipo: m.type, Descripcion: m.description, Entra: m.amount_in || 0, Sale: m.amount_out || 0, Saldo: m.balance_after }));
  exportToXLSX({ filename: 'reporte_caja.xlsx', sheets: [{ name: 'Caja', rows }] });
}

async function repExpenses() {
  const all = await getAll('expenses');
  const br = activeBranchId();
  const rows = all.filter(e => e.branch_id === br).sort((a,b) => b.datetime.localeCompare(a.datetime))
    .map(e => ({ Fecha: fmtDateTime(e.datetime), Categoria: e.category, Descripcion: e.description, Medio: e.payment_method_id, Monto: e.amount }));
  exportToXLSX({ filename: 'reporte_gastos.xlsx', sheets: [{ name: 'Gastos', rows }] });
}

async function repPnl() {
  const all = await getAll('monthly_pnl');
  const rows = all.sort((a,b) => a.month.localeCompare(b.month)).map(p => ({
    Mes: p.month, Sucursal: p.branch_id, VentasBrutas: p.gross_sales, FacturadoNeto: p.net_invoiced || p.net_sales,
    COGS: p.cogs, GananciaBruta: p.gross_profit, Gastos: p.expenses, Cheques: p.checks,
    Devoluciones: p.returns, GananciaNeta: p.net_profit,
  }));
  exportToXLSX({ filename: 'reporte_pnl.xlsx', sheets: [{ name: 'P&L mensual', rows }] });
}

async function repInventory() {
  const [products, stocks, categories, brands, suppliers, branches] = await Promise.all([
    getAll('products'), getAll('stock'), getAll('categories'), getAll('brands'), getAll('suppliers'), getAll('branches'),
  ]);
  const catMap = Object.fromEntries(categories.map(c => [c.id, c.name]));
  const brMap = Object.fromEntries(brands.map(b => [b.id, b.name]));
  const spMap = Object.fromEntries(suppliers.map(s => [s.id, s.name]));
  const rows = products.map(p => {
    const row = { Codigo: p.code, Nombre: p.name, Categoria: catMap[p.category_id] || '', Marca: brMap[p.brand_id] || '',
      Proveedor: spMap[p.supplier_id] || '', Costo: p.cost, Margen: p.margin_pct, Precio: p.price, MELI: p.published_meli ? 'Sí' : 'No' };
    let total = 0;
    for (const b of branches) {
      const s = stocks.find(x => x.product_id === p.id && x.branch_id === b.id);
      row[b.name] = s?.qty || 0;
      total += s?.qty || 0;
    }
    row.StockTotal = total;
    row.ValorizacionCosto = total * (Number(p.cost) || 0);
    row.ValorizacionVenta = total * (Number(p.price) || 0);
    return row;
  });
  exportToXLSX({ filename: 'reporte_inventario.xlsx', sheets: [{ name: 'Inventario', rows }] });
}

async function repTransfers() {
  const [transfers, branches, products] = await Promise.all([getAll('transfers'), getAll('branches'), getAll('products')]);
  const brMap = Object.fromEntries(branches.map(b => [b.id, b.name]));
  const prMap = Object.fromEntries(products.map(p => [p.id, p]));
  const header = transfers.map(t => ({
    Numero: t.number, Fecha: fmtDateTime(t.datetime),
    Origen: brMap[t.from_branch] || t.from_branch, Destino: brMap[t.to_branch] || t.to_branch,
    Items: t.items?.length || 0, Estado: t.status, Nota: t.note || '',
  }));
  const details = [];
  for (const t of transfers) {
    for (const it of (t.items || [])) {
      const p = prMap[it.product_id];
      details.push({
        Numero: t.number, Fecha: fmtDate(t.datetime),
        Producto: p?.name || it.product_id, Codigo: p?.code || '', Cantidad: it.qty,
      });
    }
  }
  exportToXLSX({ filename: 'reporte_transferencias.xlsx', sheets: [
    { name: 'Transferencias', rows: header }, { name: 'Items', rows: details },
  ]});
}

async function repStockByCat() {
  const [products, stocks, categories, branches] = await Promise.all([
    getAll('products'), getAll('stock'), getAll('categories'), getAll('branches'),
  ]);
  const catMap = Object.fromEntries(categories.map(c => [c.id, c.name]));
  const byCat = {};
  for (const p of products) {
    const cid = p.category_id || '—';
    const total = branches.reduce((s, b) => {
      const st = stocks.find(x => x.product_id === p.id && x.branch_id === b.id);
      return s + (st?.qty || 0);
    }, 0);
    if (!byCat[cid]) byCat[cid] = { qty: 0, cost: 0, price: 0, items: 0 };
    byCat[cid].qty += total;
    byCat[cid].cost += total * (Number(p.cost) || 0);
    byCat[cid].price += total * (Number(p.price) || 0);
    byCat[cid].items += 1;
  }
  const rows = Object.entries(byCat).map(([c, v]) => ({
    Categoria: catMap[c] || c, SKUs: v.items, Unidades: v.qty, ValorCosto: v.cost, ValorVenta: v.price, MargenPot: v.price - v.cost,
  }));
  exportToXLSX({ filename: 'reporte_stock_por_categoria.xlsx', sheets: [{ name: 'Stock por categoría', rows }] });
}

async function repChecks() {
  const [checks, suppliers] = await Promise.all([getAll('checks'), getAll('suppliers')]);
  const spMap = Object.fromEntries(suppliers.map(s => [s.id, s.name]));
  const rows = checks.sort((a,b) => (a.due_at||'').localeCompare(b.due_at||'')).map(c => ({
    Numero: c.number, Proveedor: spMap[c.supplier_id] || '', Banco: c.bank || '',
    Emision: fmtDate(c.issued_at), Vence: fmtDate(c.due_at), Monto: c.amount, Estado: c.status, Nota: c.note || '',
  }));
  exportToXLSX({ filename: 'reporte_cheques.xlsx', sheets: [{ name: 'Cheques', rows }] });
}

async function repEmployees() {
  const [employees, shifts, branches] = await Promise.all([getAll('employees'), getAll('shifts'), getAll('branches')]);
  const brMap = Object.fromEntries(branches.map(b => [b.id, b.name]));
  const month = monthKey();
  const rows = employees.map(e => {
    const mys = shifts.filter(s => s.employee_id === e.id && s.date.startsWith(month));
    const horas = mys.reduce((s, sh) => s + hoursDecimal(sh.check_in, sh.check_out), 0);
    return {
      Nombre: `${e.name} ${e.lastname||''}`, Sucursal: brMap[e.branch_id] || '',
      Rol: e.role || '', Activo: e.active ? 'Sí' : 'No',
      HsMes: Number(horas.toFixed(2)), RateHora: e.hourly_rate || 0,
      PagoEstimado: Number((horas * (e.hourly_rate || 0)).toFixed(2)),
    };
  });
  exportToXLSX({ filename: `reporte_empleados_${month}.xlsx`, sheets: [{ name: month, rows }] });
}

async function repAudit() {
  const all = await getAll('audit_log');
  const rows = all.sort((a,b) => b.datetime.localeCompare(a.datetime)).map(a => ({
    Fecha: fmtDateTime(a.datetime), Usuario: a.user_name || a.user_id, Accion: a.action, Entidad: a.entity, EntidadId: a.entity_id, Descripcion: a.description,
  }));
  exportToXLSX({ filename: 'reporte_auditoria.xlsx', sheets: [{ name: 'Auditoría', rows }] });
}

function prevMonthKey(mk) {
  const [y, m] = mk.split('-').map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function aggregateSales(sales, { month, branch } = {}) {
  const filtered = sales.filter(s => {
    if (s.status === 'cancelled') return false;
    if (month && !s.datetime.startsWith(month)) return false;
    if (branch && s.branch_id !== branch) return false;
    return true;
  });
  const total = filtered.reduce((a, s) => a + (Number(s.total) || 0), 0);
  const units = filtered.reduce((a, s) => a + (s.items || []).reduce((u, it) => u + (Number(it.qty) || 0), 0), 0);
  const count = filtered.length;
  const avg = count ? total / count : 0;
  return { count, units, total, avg };
}

async function repComparison() {
  const [sales, expenses, branches] = await Promise.all([
    getAll('sales'), getAll('expenses'), getAll('branches'),
  ]);
  const cur = monthKey();
  const prev = prevMonthKey(cur);

  const delta = (a, b) => (b ? ((a - b) / b) * 100 : (a ? 100 : 0));
  const row = (label, curVal, prevVal) => ({
    Métrica: label, Actual: Number((curVal || 0).toFixed(2)),
    Anterior: Number((prevVal || 0).toFixed(2)),
    Diferencia: Number(((curVal || 0) - (prevVal || 0)).toFixed(2)),
    'Variación %': Number(delta(curVal || 0, prevVal || 0).toFixed(2)),
  });

  // Sheet 1: Mes actual vs mes anterior (global)
  const curAgg = aggregateSales(sales, { month: cur });
  const prevAgg = aggregateSales(sales, { month: prev });
  const curExp = expenses.filter(e => (e.datetime || '').startsWith(cur)).reduce((a, e) => a + (Number(e.amount) || 0), 0);
  const prevExp = expenses.filter(e => (e.datetime || '').startsWith(prev)).reduce((a, e) => a + (Number(e.amount) || 0), 0);

  const monthRows = [
    { Métrica: 'Periodo', Actual: cur, Anterior: prev, Diferencia: '', 'Variación %': '' },
    row('Ventas (cantidad)', curAgg.count, prevAgg.count),
    row('Unidades vendidas', curAgg.units, prevAgg.units),
    row('Total facturado', curAgg.total, prevAgg.total),
    row('Ticket promedio', curAgg.avg, prevAgg.avg),
    row('Gastos', curExp, prevExp),
    row('Resultado operativo', curAgg.total - curExp, prevAgg.total - prevExp),
  ];

  // Sheet 2: Sucursal vs Sucursal (mes actual)
  const perBranch = branches.map(b => ({ b, agg: aggregateSales(sales, { month: cur, branch: b.id }) }));
  const branchRows = [];
  const metrics = [
    ['Ventas (cantidad)', 'count'],
    ['Unidades vendidas', 'units'],
    ['Total facturado', 'total'],
    ['Ticket promedio', 'avg'],
  ];
  for (const [label, key] of metrics) {
    const obj = { Métrica: label };
    let tot = 0;
    for (const { b, agg } of perBranch) {
      const v = Number((agg[key] || 0).toFixed(2));
      obj[b.name] = v;
      tot += v;
    }
    obj.Total = Number(tot.toFixed(2));
    branchRows.push(obj);
  }
  // Participación %
  const partRow = { Métrica: 'Participación % (Total)' };
  const grandTotal = perBranch.reduce((s, { agg }) => s + (agg.total || 0), 0);
  for (const { b, agg } of perBranch) {
    partRow[b.name] = grandTotal ? Number(((agg.total / grandTotal) * 100).toFixed(2)) : 0;
  }
  partRow.Total = 100;
  branchRows.push(partRow);

  // Sheet 3: Evolución últimos 6 meses (por sucursal)
  const evoRows = [];
  const evoMonths = [];
  let k = cur;
  for (let i = 0; i < 6; i++) { evoMonths.unshift(k); k = prevMonthKey(k); }
  for (const m of evoMonths) {
    const obj = { Mes: m };
    let tot = 0;
    for (const b of branches) {
      const agg = aggregateSales(sales, { month: m, branch: b.id });
      obj[b.name] = Number((agg.total || 0).toFixed(2));
      tot += agg.total || 0;
    }
    obj.Total = Number(tot.toFixed(2));
    evoRows.push(obj);
  }

  exportToXLSX({
    filename: `reporte_comparativa_${cur}.xlsx`,
    sheets: [
      { name: 'Mes vs Mes anterior', rows: monthRows },
      { name: 'Sucursal vs Sucursal', rows: branchRows },
      { name: 'Evolución 6 meses', rows: evoRows },
    ],
  });
}

async function repCustomers() {
  const [customers, sales] = await Promise.all([getAll('customers'), getAll('sales')]);
  const rows = customers.map(c => {
    const mySales = sales.filter(s => s.customer_id === c.id);
    return {
      Nombre: c.name, Apellido: c.lastname || '', Email: c.email || '', Telefono: c.phone || '',
      Direccion: c.address || '', Cumpleanos: c.birthday || '',
      Compras: mySales.length, Gastado: mySales.reduce((s, x) => s + (x.total || 0), 0),
      UltimaCompra: mySales.sort((a,b) => b.datetime.localeCompare(a.datetime))[0]?.datetime || '',
    };
  });
  exportToXLSX({ filename: 'reporte_clientes.xlsx', sheets: [{ name: 'Clientes', rows }] });
}
