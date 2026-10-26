// Reportes — exportaciones XLSX de todos los dominios.
// TODO-ONLINE: leen del backend (Postgres es la fuente de verdad). El catálogo
// (categorías/marcas/proveedores) sí vive en el cache local (se sincroniza al
// iniciar la app), así que esos siguen con getAll(). audit_log es legacy por-PC.

import { getAll } from '../core/db.js';
import * as Kv from '../repos/kv.js';
import { Suppliers } from '../repos/catalog.js';
import * as Products from '../repos/products.js';
import * as Cash from '../repos/cash.js';
import * as Returns from '../repos/returns.js';
import * as Employees from '../repos/employees.js';
import { api } from '../core/api.js';
import { fmtDateTime, fmtDate, monthKey, hoursDecimal } from '../core/format.js';
import { activeBranchId, isAdmin, listBranches } from '../core/auth.js';
import { exportToXLSX } from '../core/xlsx.js';
import { toast } from '../core/notifications.js';
import { openModal } from '../components/modal.js';

const REPORTS = [
  { id: 'by-customer', name: 'Compras por cliente', desc: 'Agrupado por cliente: sus compras, detalle de productos e importes. Elegís los filtros al generar.', icon: 'shopping_cart', filters: ['date', 'branch', 'source', 'customer'] },
  { id: 'sales', name: 'Ventas', desc: 'Todas las ventas con detalle', icon: 'trending_up', filters: ['date', 'branch', 'source'] },
  { id: 'returns', name: 'Devoluciones', desc: 'Devoluciones y vales emitidos', icon: 'assignment_return', filters: ['date', 'branch'] },
  { id: 'cash', name: 'Caja', desc: 'Movimientos de efectivo de la sucursal', icon: 'account_balance_wallet', filters: ['date', 'branch'] },
  { id: 'expenses', name: 'Gastos', desc: 'Gastos por categoría', icon: 'shopping_bag', filters: ['date', 'branch'] },
  { id: 'pnl', name: 'P&L mensuales', desc: 'Todos los snapshots guardados', icon: 'paid' },
  { id: 'inventory', name: 'Inventario', desc: 'Productos + stock valorizado', icon: 'inventory_2' },
  { id: 'transfers', name: 'Transferencias', desc: 'Movimientos entre sucursales', icon: 'swap_horiz', filters: ['date', 'branch'] },
  { id: 'stock-by-cat', name: 'Stock por categoría', desc: 'Resumen agrupado', icon: 'category' },
  { id: 'checks', name: 'Cheques', desc: 'Todos los cheques con estado', icon: 'receipt_long', filters: ['date'] },
  { id: 'employees', name: 'Empleados + horas', desc: 'Liquidación mensual estimada', icon: 'badge' },
  { id: 'audit', name: 'Auditoría', desc: 'Acciones por usuario y entidad (solo esta PC)', icon: 'history' },
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
  el.querySelectorAll('[data-rep]').forEach(b => b.addEventListener('click', () => runReport(b.dataset.rep, b)));
}

const REP_FNS = {
  'by-customer': repByCustomer,
  sales: repSales, returns: repReturns, cash: repCash, expenses: repExpenses,
  pnl: repPnl, inventory: repInventory, transfers: repTransfers, 'stock-by-cat': repStockByCat,
  checks: repChecks, employees: repEmployees, audit: repAudit, customers: repCustomers, comparison: repComparison,
};

async function runReport(id, btn) {
  const entry = REPORTS.find(r => r.id === id);
  const fn = REP_FNS[id];
  if (!fn) return;
  // Reportes con filtros declarados → abrir el diálogo ANTES de generar.
  let filters;
  if (entry?.filters?.length) {
    filters = await pickFilters(entry.filters, `Filtros · ${entry.name}`);
    if (!filters) return; // canceló
  }
  if (btn) btn.classList.add('opacity-60', 'pointer-events-none');
  try {
    const rows = await fn(filters);
    // null = el usuario canceló el diálogo de filtros → no avisamos nada.
    if (rows === null) return;
    // Sin datos → avisamos claro en vez del falso "Exportado ✓".
    if (rows > 0) toast('Exportado ✓', 'success');
    else toast('No hay datos para exportar en este reporte', 'warn');
  } catch (err) {
    toast('Error: ' + (err?.message || 'no se pudo generar'), 'error');
  } finally {
    if (btn) btn.classList.remove('opacity-60', 'pointer-events-none');
  }
}

// Exporta sólo si hay filas. Devuelve el total (para el aviso "Sin datos").
function saveXLSX(filename, sheets) {
  const total = sheets.reduce((n, s) => n + (s.rows?.length || 0), 0);
  if (total === 0) return 0;
  exportToXLSX({ filename, sheets });
  return total;
}

const getBranches = () => api('/api/branches').catch(() => []);
const nameOf = (c) => `${c.name || ''} ${c.lastname || ''}`.trim();

async function repSales(f = {}) {
  const qs = new URLSearchParams({ status: 'confirmed', limit: '100000' });
  if (f.from) qs.set('from', f.from + 'T00:00:00');
  if (f.to) qs.set('to', f.to + 'T23:59:59');
  if (f.branchId) qs.set('branchId', f.branchId);
  if (f.source) qs.set('source', f.source);
  const [sales, employees, products, categories, branches] = await Promise.all([
    api('/api/sales?' + qs.toString()),
    Employees.list(), Products.list(), getAll('categories'), getBranches(),
  ]);
  const emMap = Object.fromEntries((employees || []).map(e => [e.id, nameOf(e)]));
  const catMap = Object.fromEntries((categories || []).map(c => [c.id, c.name]));
  const brMap = Object.fromEntries((branches || []).map(b => [b.id, b.name]));
  const vMap = {};
  for (const p of (products || [])) {
    for (const v of (p.variants || [])) {
      vMap[v.id] = { code: v.code || p.code || '', category: catMap[p.category_id] || '' };
    }
  }
  const header = (sales || []).map(s => ({
    Numero: s.number, Fecha: fmtDateTime(s.datetime), Sucursal: brMap[s.branchId] || s.branchId,
    Cliente: s.customer?.name || '', Vendedor: emMap[s.sellerId] || '',
    Origen: s.source === 'tn' ? 'Tienda Nube' : 'POS',
    Items: s.items?.length || 0, Total: s.total,
    Pagos: (s.payments || []).map(p => `${p.methodName || p.methodId}: ${p.amount}`).join(' · '),
  }));
  const details = [];
  for (const s of (sales || [])) {
    for (const it of (s.items || [])) {
      const info = vMap[it.variantId] || {};
      const variante = it.variantNameSnap && it.variantNameSnap !== 'default' ? ` (${it.variantNameSnap})` : '';
      details.push({
        Numero: s.number, Fecha: fmtDate(s.datetime), Producto: `${it.productNameSnap}${variante}`,
        Codigo: info.code || '', Categoria: info.category || '', Cantidad: it.qty,
        Precio: it.unitPrice, Costo: it.costSnapshot, Subtotal: it.subtotal,
      });
    }
  }
  return saveXLSX('reporte_ventas.xlsx', [
    { name: 'Ventas', rows: header }, { name: 'Detalle items', rows: details },
  ]);
}

// ---------- Filtros elegibles al generar (diálogo genérico reutilizable) ----------
const docOf = (c) => [c?.documentType, c?.documentNumber].filter(Boolean).join(' ').trim();

// Filtra por rango de fechas (inclusive) usando el día completo. from/to = 'YYYY-MM-DD'.
const dtInRange = (dt, from, to) => {
  if (!dt) return !from && !to ? true : false;
  const t = new Date(dt).getTime();
  if (from && t < new Date(from + 'T00:00:00').getTime()) return false;
  if (to && t > new Date(to + 'T23:59:59').getTime()) return false;
  return true;
};

// Diálogo de filtros genérico. `fields` ⊆ ['date','branch','source','customer'].
// Devuelve {from,to,branchId,source,term,onlyWithCustomer} o null si cancela.
function pickFilters(fields = [], title = 'Filtros del reporte') {
  const has = (k) => fields.includes(k);
  return new Promise(async (resolve) => {
    const admin = isAdmin();
    let branches = [];
    if (has('branch')) { try { branches = await listBranches(); } catch { branches = []; } }
    const branchOptions = admin
      ? `<option value="">Todas</option>` + branches.map(b => `<option value="${b.id}">${b.name}</option>`).join('')
      : branches.filter(b => b.id === activeBranchId()).map(b => `<option value="${b.id}">${b.name}</option>`).join('');
    const parts = [];
    if (has('date')) parts.push(`
      <label class="block"><span class="text-xs font-bold text-[#7d6c5c]">Desde</span>
        <input id="rf-from" type="date" class="ing-input w-full mt-1" /></label>
      <label class="block"><span class="text-xs font-bold text-[#7d6c5c]">Hasta</span>
        <input id="rf-to" type="date" class="ing-input w-full mt-1" /></label>`);
    if (has('branch')) parts.push(`
      <label class="block"><span class="text-xs font-bold text-[#7d6c5c]">Sucursal</span>
        <select id="rf-branch" class="ing-input w-full mt-1" ${admin ? '' : 'disabled'}>${branchOptions}</select></label>`);
    if (has('source')) parts.push(`
      <label class="block"><span class="text-xs font-bold text-[#7d6c5c]">Origen</span>
        <select id="rf-source" class="ing-input w-full mt-1">
          <option value="">Todos</option><option value="pos">POS (local)</option><option value="tn">Tienda Nube</option>
        </select></label>`);
    if (has('customer')) parts.push(`
      <label class="block col-span-2"><span class="text-xs font-bold text-[#7d6c5c]">Cliente (nombre o documento, opcional)</span>
        <input id="rf-term" class="ing-input w-full mt-1" placeholder="Dejar vacío = todos los clientes" /></label>
      <label class="col-span-2 flex items-center gap-2 mt-1 text-sm">
        <input id="rf-onlycust" type="checkbox" checked class="w-4 h-4" />
        <span>Solo compras con cliente identificado</span></label>`);
    openModal({
      title, size: 'md',
      bodyHTML: `<div class="grid grid-cols-2 gap-3">${parts.join('')}</div>
        <p class="text-xs text-[#7d6c5c] mt-3">Las fechas vacías = sin límite.</p>`,
      footerHTML: `<button class="ing-btn-secondary" data-act="cancel">Cancelar</button>
                   <button class="ing-btn-primary" data-act="ok"><span class="material-symbols-outlined text-sm align-middle">download</span> Generar</button>`,
      onOpen: (el, close) => {
        const g = (id) => el.querySelector(id);
        el.querySelector('[data-act="cancel"]').addEventListener('click', () => close(null));
        el.querySelector('[data-act="ok"]').addEventListener('click', () => {
          close({
            from: has('date') ? (g('#rf-from').value || undefined) : undefined,
            to: has('date') ? (g('#rf-to').value || undefined) : undefined,
            branchId: has('branch') ? (admin ? (g('#rf-branch').value || undefined) : activeBranchId()) : undefined,
            source: has('source') ? (g('#rf-source').value || undefined) : undefined,
            term: has('customer') ? g('#rf-term').value.trim().toLowerCase() : '',
            onlyWithCustomer: has('customer') ? g('#rf-onlycust').checked : false,
          });
        });
      },
    }).then((v) => resolve(v ?? null));
  });
}

async function repByCustomer(f = {}) {
  // Query de ventas con los filtros. 'to' incluye el día entero.
  const qs = new URLSearchParams({ status: 'confirmed', limit: '100000' });
  if (f.from) qs.set('from', f.from + 'T00:00:00');
  if (f.to) qs.set('to', f.to + 'T23:59:59');
  if (f.branchId) qs.set('branchId', f.branchId);
  if (f.source) qs.set('source', f.source);
  const [sales, customers, products, categories, branches] = await Promise.all([
    api('/api/sales?' + qs.toString()),
    api('/api/customers').catch(() => []),
    Products.list(), getAll('categories'), getBranches(),
  ]);
  const catMap = Object.fromEntries((categories || []).map(c => [c.id, c.name]));
  const brMap = Object.fromEntries((branches || []).map(b => [b.id, b.name]));
  const cuMap = Object.fromEntries((customers || []).map(c => [c.id, c]));
  const vMap = {};
  for (const p of (products || [])) {
    for (const v of (p.variants || [])) vMap[v.id] = { code: v.code || p.code || '', category: catMap[p.category_id] || '' };
  }
  const SIN = '__sin_cliente__';
  // Agrupar ventas por cliente, aplicando filtros de cliente/identificado.
  const groups = new Map(); // key -> { cliente, ventas: [] }
  for (const s of (sales || [])) {
    const cust = s.customerId ? cuMap[s.customerId] : null;
    if (f.onlyWithCustomer && !cust) continue;
    if (f.term) {
      const hay = `${cust?.name || ''} ${docOf(cust)}`.toLowerCase();
      if (!hay.includes(f.term)) continue;
    }
    const key = cust?.id || SIN;
    if (!groups.has(key)) groups.set(key, { cliente: cust, ventas: [] });
    groups.get(key).ventas.push(s);
  }

  const resumen = [], compras = [], detalle = [];
  // Orden: por total gastado desc.
  const ordered = [...groups.values()].sort((a, b) =>
    b.ventas.reduce((n, s) => n + (s.total || 0), 0) - a.ventas.reduce((n, s) => n + (s.total || 0), 0));
  for (const g of ordered) {
    const c = g.cliente;
    const nombre = c?.name || 'Consumidor final (sin cliente)';
    const doc = docOf(c);
    const vs = g.ventas.slice().sort((a, b) => String(a.datetime).localeCompare(String(b.datetime)));
    const totalGastado = vs.reduce((n, s) => n + (s.total || 0), 0);
    const unidades = vs.reduce((n, s) => n + (s.items || []).reduce((m, it) => m + (it.qty || 0), 0), 0);
    resumen.push({
      Cliente: nombre, Documento: doc, Telefono: c?.phone || '', Email: c?.email || '',
      Direccion: c?.address || '', Ciudad: c?.city || '',
      Compras: vs.length, Unidades: unidades, TotalGastado: totalGastado,
      PrimeraCompra: vs[0] ? fmtDate(vs[0].datetime) : '', UltimaCompra: vs.length ? fmtDate(vs[vs.length - 1].datetime) : '',
    });
    for (const s of vs) {
      compras.push({
        Cliente: nombre, Documento: doc, NumeroVenta: s.number, Fecha: fmtDateTime(s.datetime),
        Sucursal: brMap[s.branchId] || s.branchId, Origen: s.source === 'tn' ? 'Tienda Nube' : 'POS',
        Items: (s.items || []).length, Total: s.total,
        Pagos: (s.payments || []).map(p => `${p.methodName || p.methodId}: ${p.amount}`).join(' · '),
      });
      for (const it of (s.items || [])) {
        const info = vMap[it.variantId] || {};
        const variante = it.variantNameSnap && it.variantNameSnap !== 'default' ? ` (${it.variantNameSnap})` : '';
        detalle.push({
          Cliente: nombre, Documento: doc, NumeroVenta: s.number, Fecha: fmtDate(s.datetime),
          Producto: `${it.productNameSnap}${variante}`, Codigo: info.code || '', Categoria: info.category || '',
          Cantidad: it.qty, PrecioUnit: it.unitPrice, Subtotal: it.subtotal,
        });
      }
    }
  }
  return saveXLSX('reporte_compras_por_cliente.xlsx', [
    { name: 'Resumen por cliente', rows: resumen },
    { name: 'Compras', rows: compras },
    { name: 'Detalle productos', rows: detalle },
  ]);
}

async function repReturns(f = {}) {
  const [returnsAll, customers, creditNotes] = await Promise.all([
    Returns.list(), api('/api/customers').catch(() => []), Returns.listCreditNotes(),
  ]);
  const returns = (returnsAll || []).filter(r =>
    dtInRange(r.datetime, f.from, f.to) && (!f.branchId || r.branchId === f.branchId));
  const cuMap = Object.fromEntries((customers || []).map(c => [c.id, nameOf(c)]));
  const cnMap = Object.fromEntries((creditNotes || []).map(v => [v.id, v.code]));
  const rows = (returns || []).map(r => ({
    Numero: r.number, Fecha: fmtDateTime(r.datetime), Cliente: cuMap[r.customerId] || '',
    Devuelve: r.returnedTotal, Lleva: r.takenTotal, 'Diferencia (+cobrado / -devuelto)': -Number(r.difference || 0),
    Vale: cnMap[r.creditNoteId] || '', Motivo: r.reason || '',
  }));
  const vales = (creditNotes || []).filter(v => dtInRange(v.issuedAt, f.from, f.to)).map(v => ({
    Codigo: v.code, Cliente: cuMap[v.customerId] || '', Monto: v.amount,
    Emitido: fmtDate(v.issuedAt), Vence: fmtDate(v.expiresAt),
    Canjeado: v.redeemedAt ? fmtDate(v.redeemedAt) : '',
  }));
  return saveXLSX('reporte_devoluciones.xlsx', [
    { name: 'Devoluciones', rows }, { name: 'Vales', rows: vales },
  ]);
}

// Sucursales a consultar según el filtro: la elegida, o todas (admin) / la activa.
async function branchesToQuery(f) {
  const branches = await getBranches();
  const ids = f?.branchId ? [f.branchId] : (isAdmin() ? (branches || []).map(b => b.id) : [activeBranchId()]);
  const brMap = Object.fromEntries((branches || []).map(b => [b.id, b.name]));
  return { ids, brMap };
}

async function repCash(f = {}) {
  const { ids, brMap } = await branchesToQuery(f);
  const all = [];
  for (const id of ids) {
    const movs = await Cash.listMovements(id).catch(() => []);
    for (const m of (movs || [])) all.push({ ...m, __branch: id });
  }
  const rows = all
    .filter(m => dtInRange(m.datetime, f.from, f.to))
    .sort((a, b) => String(a.datetime).localeCompare(String(b.datetime)))
    .map(m => ({
      Fecha: fmtDateTime(m.datetime), Sucursal: brMap[m.__branch] || m.__branch, Tipo: m.type,
      Descripcion: m.description, Entra: m.amount_in || 0, Sale: m.amount_out || 0, Saldo: m.balance_after,
    }));
  return saveXLSX('reporte_caja.xlsx', [{ name: 'Caja', rows }]);
}

async function repExpenses(f = {}) {
  const { ids, brMap } = await branchesToQuery(f);
  const all = [];
  for (const id of ids) {
    const exp = await Cash.listExpenses(id).catch(() => []);
    for (const e of (exp || [])) all.push({ ...e, __branch: id });
  }
  const rows = all
    .filter(e => dtInRange(e.datetime, f.from, f.to))
    .sort((a, b) => String(a.datetime).localeCompare(String(b.datetime)))
    .map(e => ({
      Fecha: fmtDateTime(e.datetime), Sucursal: brMap[e.__branch] || e.__branch, Categoria: e.category,
      Descripcion: e.description, Medio: e.payment_method_id, Monto: e.amount,
    }));
  return saveXLSX('reporte_gastos.xlsx', [{ name: 'Gastos', rows }]);
}

async function repPnl() {
  const all = await Kv.list('monthly_pnl').catch(() => []);
  const rows = (all || []).sort((a, b) => a.month.localeCompare(b.month)).map(p => ({
    Mes: p.month, Sucursal: p.branch_id, VentasBrutas: p.gross_sales, FacturadoNeto: p.net_invoiced || p.net_sales,
    COGS: p.cogs, GananciaBruta: p.gross_profit, Gastos: p.expenses, Cheques: p.checks,
    Devoluciones: p.returns, GananciaNeta: p.net_profit,
  }));
  return saveXLSX('reporte_pnl.xlsx', [{ name: 'P&L mensual', rows }]);
}

async function repInventory() {
  const [products, stocks, categories, brands, suppliers, branches] = await Promise.all([
    Products.list(), Products.listStock(), getAll('categories'), getAll('brands'), getAll('suppliers'), getBranches(),
  ]);
  const catMap = Object.fromEntries((categories || []).map(c => [c.id, c.name]));
  const brMap = Object.fromEntries((brands || []).map(b => [b.id, b.name]));
  const spMap = Object.fromEntries((suppliers || []).map(s => [s.id, s.name]));
  const rows = (products || []).map(p => {
    const row = {
      Codigo: p.code, Nombre: p.name, Categoria: catMap[p.category_id] || '', Marca: brMap[p.brand_id] || '',
      Proveedor: spMap[p.supplier_id] || '', Costo: p.cost, Margen: p.margin_pct, Precio: p.price, MELI: p.published_meli ? 'Sí' : 'No',
    };
    let total = 0;
    for (const b of (branches || [])) {
      const s = (stocks || []).find(x => x.product_id === p.id && x.branch_id === b.id);
      row[b.name] = s?.qty || 0;
      total += s?.qty || 0;
    }
    row.StockTotal = total;
    row.ValorizacionCosto = total * (Number(p.cost) || 0);
    row.ValorizacionVenta = total * (Number(p.price) || 0);
    return row;
  });
  return saveXLSX('reporte_inventario.xlsx', [{ name: 'Inventario', rows }]);
}

async function repTransfers(f = {}) {
  const [transfersAll, branches, products] = await Promise.all([
    api('/api/transfers').catch(() => []), getBranches(), Products.list(),
  ]);
  const transfers = (transfersAll || []).filter(t =>
    dtInRange(t.datetime, f.from, f.to) &&
    (!f.branchId || t.fromBranch === f.branchId || t.toBranch === f.branchId));
  const brMap = Object.fromEntries((branches || []).map(b => [b.id, b.name]));
  const vInfo = {};
  for (const p of (products || [])) {
    for (const v of (p.variants || [])) vInfo[v.id] = { name: p.name, code: v.code || p.code || '' };
  }
  const remito = (t) => `R-${String(t.number).padStart(6, '0')}`;
  const header = (transfers || []).map(t => ({
    Numero: remito(t), Fecha: fmtDateTime(t.datetime),
    Origen: brMap[t.fromBranch] || t.fromBranch, Destino: brMap[t.toBranch] || t.toBranch,
    Items: t.items?.length || 0, Estado: t.status, Nota: t.notes || '',
  }));
  const details = [];
  for (const t of (transfers || [])) {
    for (const it of (t.items || [])) {
      const info = vInfo[it.variantId] || {};
      details.push({
        Numero: remito(t), Fecha: fmtDate(t.datetime),
        Producto: info.name || it.variantId, Codigo: info.code || '', Cantidad: it.qty,
      });
    }
  }
  return saveXLSX('reporte_transferencias.xlsx', [
    { name: 'Transferencias', rows: header }, { name: 'Items', rows: details },
  ]);
}

async function repStockByCat() {
  const [products, stocks, categories, branches] = await Promise.all([
    Products.list(), Products.listStock(), getAll('categories'), getBranches(),
  ]);
  const catMap = Object.fromEntries((categories || []).map(c => [c.id, c.name]));
  const byCat = {};
  for (const p of (products || [])) {
    const cid = p.category_id || '—';
    const total = (branches || []).reduce((s, b) => {
      const st = (stocks || []).find(x => x.product_id === p.id && x.branch_id === b.id);
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
  return saveXLSX('reporte_stock_por_categoria.xlsx', [{ name: 'Stock por categoría', rows }]);
}

async function repChecks(f = {}) {
  const [checksAll, suppliers] = await Promise.all([Kv.list('checks').catch(() => []), Suppliers.list().catch(() => [])]);
  const spMap = Object.fromEntries((suppliers || []).map(s => [s.id, s.name]));
  const checks = (checksAll || []).filter(c => dtInRange(c.issued_at, f.from, f.to));
  const rows = (checks || []).sort((a, b) => (a.due_at || '').localeCompare(b.due_at || '')).map(c => ({
    Numero: c.number, Proveedor: spMap[c.supplier_id] || '', Banco: c.bank || '',
    Emision: fmtDate(c.issued_at), Vence: fmtDate(c.due_at), Monto: c.amount, Estado: c.status, Nota: c.note || '',
  }));
  return saveXLSX('reporte_cheques.xlsx', [{ name: 'Cheques', rows }]);
}

async function repEmployees() {
  const month = monthKey();
  const [employees, shifts, branches] = await Promise.all([
    Employees.list(), Employees.listShifts(undefined, month), getBranches(),
  ]);
  const brMap = Object.fromEntries((branches || []).map(b => [b.id, b.name]));
  const rows = (employees || []).map(e => {
    const mys = (shifts || []).filter(s => s.employeeId === e.id);
    const horas = mys.reduce((s, sh) => s + hoursDecimal(sh.checkIn, sh.checkOut), 0);
    return {
      Nombre: nameOf(e), Sucursal: brMap[e.branchId] || '',
      Rol: e.role || '', Activo: e.active ? 'Sí' : 'No',
      HsMes: Number(horas.toFixed(2)), RateHora: e.hourlyRate || 0,
      PagoEstimado: Number((horas * (e.hourlyRate || 0)).toFixed(2)),
    };
  });
  return saveXLSX(`reporte_empleados_${month}.xlsx`, [{ name: month, rows }]);
}

async function repAudit() {
  // Auditoría legacy: vive en IndexedDB de ESTA PC (no está consolidada en el backend).
  const all = await getAll('audit_log');
  const rows = (all || []).sort((a, b) => b.datetime.localeCompare(a.datetime)).map(a => ({
    Fecha: fmtDateTime(a.datetime), Usuario: a.user_name || a.user_id, Accion: a.action, Entidad: a.entity, EntidadId: a.entity_id, Descripcion: a.description,
  }));
  return saveXLSX('reporte_auditoria.xlsx', [{ name: 'Auditoría (solo esta PC)', rows }]);
}

function prevMonthKey(mk) {
  const [y, m] = mk.split('-').map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function aggregateSales(sales, { month, branch } = {}) {
  const filtered = (sales || []).filter(s => {
    if (s.status === 'cancelled') return false;
    if (month && !String(s.datetime).startsWith(month)) return false;
    if (branch && s.branchId !== branch) return false;
    return true;
  });
  const total = filtered.reduce((a, s) => a + (Number(s.total) || 0), 0);
  const units = filtered.reduce((a, s) => a + (s.items || []).reduce((u, it) => u + (Number(it.qty) || 0), 0), 0);
  const count = filtered.length;
  const avg = count ? total / count : 0;
  return { count, units, total, avg };
}

async function repComparison() {
  const branches = await getBranches();
  const [sales, expensesArrays] = await Promise.all([
    api('/api/sales?limit=100000'),
    Promise.all((branches || []).map(b => Cash.listExpenses(b.id).catch(() => []))),
  ]);
  const expenses = expensesArrays.flat();
  const cur = monthKey();
  const prev = prevMonthKey(cur);

  const delta = (a, b) => (b ? ((a - b) / b) * 100 : (a ? 100 : 0));
  const row = (label, curVal, prevVal) => ({
    Métrica: label, Actual: Number((curVal || 0).toFixed(2)),
    Anterior: Number((prevVal || 0).toFixed(2)),
    Diferencia: Number(((curVal || 0) - (prevVal || 0)).toFixed(2)),
    'Variación %': Number(delta(curVal || 0, prevVal || 0).toFixed(2)),
  });

  const curAgg = aggregateSales(sales, { month: cur });
  const prevAgg = aggregateSales(sales, { month: prev });
  const curExp = expenses.filter(e => String(e.datetime || '').startsWith(cur)).reduce((a, e) => a + (Number(e.amount) || 0), 0);
  const prevExp = expenses.filter(e => String(e.datetime || '').startsWith(prev)).reduce((a, e) => a + (Number(e.amount) || 0), 0);

  const monthRows = [
    { Métrica: 'Periodo', Actual: cur, Anterior: prev, Diferencia: '', 'Variación %': '' },
    row('Ventas (cantidad)', curAgg.count, prevAgg.count),
    row('Unidades vendidas', curAgg.units, prevAgg.units),
    row('Total facturado', curAgg.total, prevAgg.total),
    row('Ticket promedio', curAgg.avg, prevAgg.avg),
    row('Gastos', curExp, prevExp),
    row('Resultado operativo', curAgg.total - curExp, prevAgg.total - prevExp),
  ];

  const perBranch = (branches || []).map(b => ({ b, agg: aggregateSales(sales, { month: cur, branch: b.id }) }));
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
  const partRow = { Métrica: 'Participación % (Total)' };
  const grandTotal = perBranch.reduce((s, { agg }) => s + (agg.total || 0), 0);
  for (const { b, agg } of perBranch) {
    partRow[b.name] = grandTotal ? Number(((agg.total / grandTotal) * 100).toFixed(2)) : 0;
  }
  partRow.Total = 100;
  branchRows.push(partRow);

  const evoRows = [];
  const evoMonths = [];
  let k = cur;
  for (let i = 0; i < 6; i++) { evoMonths.unshift(k); k = prevMonthKey(k); }
  for (const m of evoMonths) {
    const obj = { Mes: m };
    let tot = 0;
    for (const b of (branches || [])) {
      const agg = aggregateSales(sales, { month: m, branch: b.id });
      obj[b.name] = Number((agg.total || 0).toFixed(2));
      tot += agg.total || 0;
    }
    obj.Total = Number(tot.toFixed(2));
    evoRows.push(obj);
  }

  return saveXLSX(`reporte_comparativa_${cur}.xlsx`, [
    { name: 'Mes vs Mes anterior', rows: monthRows },
    { name: 'Sucursal vs Sucursal', rows: branchRows },
    { name: 'Evolución 6 meses', rows: evoRows },
  ]);
}

async function repCustomers() {
  const [customers, sales] = await Promise.all([
    api('/api/customers').catch(() => []), api('/api/sales?status=confirmed&limit=100000'),
  ]);
  const rows = (customers || []).map(c => {
    const mySales = (sales || []).filter(s => s.customerId === c.id);
    return {
      Nombre: c.name, Apellido: c.lastname || '', Email: c.email || '', Telefono: c.phone || '',
      Direccion: c.address || '', Cumpleanos: c.birthday || '',
      Compras: mySales.length, Gastado: mySales.reduce((s, x) => s + (x.total || 0), 0),
      UltimaCompra: mySales.sort((a, b) => String(b.datetime).localeCompare(String(a.datetime)))[0]?.datetime || '',
    };
  });
  return saveXLSX('reporte_clientes.xlsx', [{ name: 'Clientes', rows }]);
}
