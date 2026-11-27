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
import { multiFilterHtml, mountMultiFilter } from '../components/multifilter.js';

const REPORTS = [
  { id: 'by-customer', name: 'Compras por cliente', desc: 'Agrupado por cliente: sus compras, detalle de productos e importes. Elegís los filtros al generar.', icon: 'shopping_cart', filters: ['date', 'branch', 'source', 'customer'] },
  { id: 'sales', name: 'Ventas', desc: 'Todas las ventas con costo, ganancia y margen; detalle por ítem. Filtrable por proveedor.', icon: 'trending_up', filters: ['date', 'branch', 'source', 'supplier'] },
  { id: 'by-seller', name: 'Ventas por vendedor', desc: 'Agrupado por vendedor. Período mensual o anual.', icon: 'badge', filters: ['period', 'branch', 'source'] },
  { id: 'by-supplier', name: 'Ventas por proveedor', desc: 'Por proveedor: ventas, unidades, importe, costo, ganancia, margen y participación. Filtrable por proveedor. Mensual o anual.', icon: 'local_shipping', filters: ['period', 'branch', 'source', 'supplier'] },
  { id: 'by-category', name: 'Ventas por rubro', desc: 'Unidades e importe por rubro (categoría), filtrable por proveedor. Mensual o anual.', icon: 'category', filters: ['period', 'branch', 'source', 'supplier'] },
  { id: 'by-customer-sum', name: 'Ventas por cliente', desc: 'Resumen por cliente: ventas, unidades e importe. Mensual o anual.', icon: 'groups', filters: ['period', 'branch', 'source'] },
  { id: 'by-payment', name: 'Ventas por medio de pago', desc: 'Una hoja por cada medio de pago. Mensual o anual.', icon: 'payments', filters: ['period', 'branch'] },
  { id: 'profit', name: 'Ganancia (promos y costos)', desc: 'Ganancia por venta/promo/banco/canal, con comisiones, financiero y acreditaciones. Mensual o anual.', icon: 'savings', filters: ['period', 'branch', 'source'] },
  { id: 'stock-snapshot', name: 'Stock inicial vs final', desc: 'Stock al inicio y al cierre del período, por producto. Mensual o anual.', icon: 'inventory', filters: ['period', 'branch'] },
  { id: 'returns', name: 'Devoluciones', desc: 'Devoluciones y vales emitidos', icon: 'assignment_return', filters: ['date', 'branch'] },
  { id: 'cash', name: 'Caja', desc: 'Movimientos de efectivo de la sucursal', icon: 'account_balance_wallet', filters: ['date', 'branch'] },
  { id: 'expenses', name: 'Gastos', desc: 'Gastos por categoría', icon: 'shopping_bag', filters: ['date', 'branch'] },
  { id: 'pnl', name: 'P&L mensuales', desc: 'Todos los snapshots guardados', icon: 'paid' },
  { id: 'inventory', name: 'Inventario', desc: 'Productos + stock valorizado, ganancia unit./potencial y % del valorizado. Filtrable por proveedor.', icon: 'inventory_2', filters: ['supplier'] },
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
  'by-seller': repBySeller, 'by-supplier': repBySupplier, 'by-category': repByCategory,
  'by-customer-sum': repByCustomerSum, 'by-payment': repByPayment, 'stock-snapshot': repStockSnapshot, profit: repProfit,
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
  wantColumnFilter = !!filters?.columnFilter;
  try {
    if (filters?.branchesSeparate) {
      // "Las dos sucursales" → una exportación por sucursal, en archivos separados.
      const all = await listBranches().catch(() => []);
      const picked = filters.branchIdsPicked?.length ? all.filter(b => filters.branchIdsPicked.includes(b.id)) : all;
      let files = 0;
      for (const b of picked) {
        batchExport = { suffix: sheetSafe(b.name).replace(/\s+/g, '_') };
        try {
          const r = await fn({ ...filters, branchId: b.id, branchesSeparate: false });
          if (typeof r === 'number' && r > 0) files++;
        } finally { batchExport = null; }
      }
      if (files > 0) toast(`Exportado ✓ — ${files} archivo${files === 1 ? '' : 's'}, uno por sucursal`, 'success');
      else toast('No hay datos para exportar en este reporte', 'warn');
    } else {
      const rows = await fn(filters);
      // null = el usuario canceló el diálogo de columnas → no avisamos nada.
      if (rows === null) return;
      // Sin datos → avisamos claro en vez del falso "Exportado ✓".
      if (rows > 0) toast('Exportado ✓', 'success');
      else toast('No hay datos para exportar en este reporte', 'warn');
    }
  } catch (err) {
    toast('Error: ' + (err?.message || 'no se pudo generar'), 'error');
  } finally {
    if (btn) btn.classList.remove('opacity-60', 'pointer-events-none');
    batchExport = null;
    wantColumnFilter = false;
  }
}

// Cuando se exporta UNA sucursal dentro de un lote (elegiste "las dos" → un archivo por
// sucursal), esto lleva el sufijo del nombre; en ese modo NO se abre el diálogo de columnas.
let batchExport = null;
// Sólo si el usuario tildó "Filtrar por columnas antes de bajar" se abre ese diálogo.
// Por defecto FALSE → la descarga es directa (no se frena con un diálogo extra).
let wantColumnFilter = false;

// Exporta sólo si hay filas. Por defecto baja directo. Si wantColumnFilter, ofrece filtrar por
// columna antes. En modo lote (batchExport) baja directo con el sufijo de la sucursal.
// Devuelve el total exportado, 0 si no quedaron filas, o null si canceló el diálogo.
async function saveXLSX(filename, sheets) {
  const total = sheets.reduce((n, s) => n + (s.rows?.length || 0), 0);
  if (total === 0) return 0;
  if (batchExport) {
    const fname = batchExport.suffix ? filename.replace(/\.xlsx$/i, `_${batchExport.suffix}.xlsx`) : filename;
    exportToXLSX({ filename: fname, sheets });
    return total;
  }
  if (!wantColumnFilter) { exportToXLSX({ filename, sheets }); return total; }
  const filters = await pickColumnFilters(sheets, filename);
  if (filters === null) return null; // canceló
  const filtered = applyColumnFilters(sheets, filters);
  const ftotal = filtered.reduce((n, s) => n + (s.rows?.length || 0), 0);
  if (ftotal === 0) return 0;
  exportToXLSX({ filename, sheets: filtered });
  return ftotal;
}

const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Infiere cómo filtrar una columna a partir de sus valores:
//  - number: todos los valores no vacíos son números → rango desde/hasta
//  - list:   pocos valores distintos (≤ 20) → casilleros para elegir
//  - text:   el resto → "contiene"
function colTypeOf(rows, col) {
  let hasEmpty = false;
  const vals = [];
  for (const r of rows) {
    const v = r[col];
    if (v === '' || v == null) { hasEmpty = true; continue; }
    vals.push(v);
  }
  if (!vals.length) return { kind: 'text', hasEmpty };
  const allNum = vals.every((v) => typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))));
  if (allNum) return { kind: 'number', hasEmpty };
  const distinct = [...new Set(vals.map((v) => String(v)))];
  if (distinct.length <= 20) return { kind: 'list', values: distinct.sort((a, b) => a.localeCompare(b, 'es', { numeric: true })), hasEmpty };
  return { kind: 'text', hasEmpty };
}

// Diálogo genérico de filtros por columna. Una sección por hoja; un control por columna
// según su tipo. Todo arranca "sin filtrar": lo que el usuario deja vacío no filtra.
// Devuelve un array de filtros [{si, col, kind, ...}] (puede ser []), o null si cancela.
function pickColumnFilters(sheets, filename) {
  const specs = []; // {si, col, kind, options?}
  let body = '';
  sheets.forEach((sheet, si) => {
    const rows = sheet.rows || [];
    if (!rows.length) return;
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    if (!cols.length) return;
    body += `<div class="mb-4"><div class="text-xs font-black uppercase text-[#7d6c5c] mb-2">Hoja: ${escHtml(sheet.name)}</div><div class="grid grid-cols-2 gap-3">`;
    for (const col of cols) {
      const t = colTypeOf(rows, col);
      const i = specs.length;
      specs.push({ si, col, kind: t.kind });
      if (t.kind === 'number') {
        body += `<div><label class="text-xs font-bold text-[#7d6c5c]">${escHtml(col)}</label>
          <div class="flex gap-1 mt-1">
            <input data-spec="${i}" data-role="min" type="number" step="any" placeholder="desde" class="ing-input w-full" />
            <input data-spec="${i}" data-role="max" type="number" step="any" placeholder="hasta" class="ing-input w-full" />
          </div></div>`;
      } else if (t.kind === 'list') {
        const opts = t.values.map((v) => `<label class="flex items-center gap-1 text-xs"><input data-spec="${i}" data-role="list" type="checkbox" value="${escHtml(v)}" checked class="w-3.5 h-3.5" /> ${escHtml(v)}</label>`).join('');
        const emptyOpt = t.hasEmpty ? `<label class="flex items-center gap-1 text-xs"><input data-spec="${i}" data-role="list" value="" type="checkbox" checked class="w-3.5 h-3.5" /> <i>(vacío)</i></label>` : '';
        body += `<div><label class="text-xs font-bold text-[#7d6c5c]">${escHtml(col)}</label>
          <div class="mt-1 max-h-28 overflow-auto border border-[#fff1e6] rounded-lg p-1.5 space-y-0.5">${opts}${emptyOpt}</div></div>`;
      } else {
        body += `<div><label class="text-xs font-bold text-[#7d6c5c]">${escHtml(col)}</label>
          <input data-spec="${i}" data-role="text" placeholder="contiene…" class="ing-input w-full mt-1" /></div>`;
      }
    }
    body += `</div></div>`;
  });
  if (!specs.length) return Promise.resolve([]); // nada que filtrar

  return new Promise((resolve) => {
    openModal({
      title: 'Filtrar por columna (opcional)', size: 'lg',
      bodyHTML: `<div style="max-height:60vh;overflow:auto">${body}</div>
        <p class="text-xs text-[#7d6c5c] mt-3">Acotá lo que quieras y tocá <b>Descargar</b>. Lo que dejes vacío no filtra. En las listas, destildá lo que no quieras incluir.</p>`,
      footerHTML: `<button class="ing-btn-secondary" data-act="cancel">Cancelar</button>
                   <button class="ing-btn-primary" data-act="ok"><span class="material-symbols-outlined text-sm align-middle">download</span> Descargar</button>`,
      onOpen: (el, close) => {
        el.querySelector('[data-act="cancel"]').addEventListener('click', () => close(null));
        el.querySelector('[data-act="ok"]').addEventListener('click', () => {
          const filters = [];
          specs.forEach((spec, i) => {
            if (spec.kind === 'number') {
              const min = el.querySelector(`[data-spec="${i}"][data-role="min"]`).value;
              const max = el.querySelector(`[data-spec="${i}"][data-role="max"]`).value;
              if (min === '' && max === '') return;
              filters.push({ si: spec.si, col: spec.col, kind: 'number', lo: min === '' ? -Infinity : Number(min), hi: max === '' ? Infinity : Number(max) });
            } else if (spec.kind === 'list') {
              const boxes = [...el.querySelectorAll(`[data-spec="${i}"][data-role="list"]`)];
              const checked = boxes.filter((b) => b.checked);
              if (checked.length === boxes.length || checked.length === 0) return; // todo o nada = sin filtro
              filters.push({ si: spec.si, col: spec.col, kind: 'list', allowed: new Set(checked.map((b) => b.value)) });
            } else {
              const term = el.querySelector(`[data-spec="${i}"][data-role="text"]`).value.trim().toLowerCase();
              if (term) filters.push({ si: spec.si, col: spec.col, kind: 'text', term });
            }
          });
          close(filters);
        });
      },
    }).then((v) => resolve(v ?? null));
  });
}

// Aplica los filtros elegidos, cada uno sobre su hoja. No muta las hojas originales.
function applyColumnFilters(sheets, filters) {
  if (!filters || !filters.length) return sheets;
  return sheets.map((sheet, si) => {
    const fs = filters.filter((f) => f.si === si);
    if (!fs.length) return sheet;
    const rows = (sheet.rows || []).filter((row) => fs.every((f) => {
      const v = row[f.col];
      if (f.kind === 'number') { const n = Number(v); return !isNaN(n) && n >= f.lo && n <= f.hi; }
      if (f.kind === 'list') return f.allowed.has(v === '' || v == null ? '' : String(v));
      return String(v == null ? '' : v).toLowerCase().includes(f.term);
    }));
    return { ...sheet, rows };
  });
}

const getBranches = () => api('/api/branches').catch(() => []);

// Orígenes elegidos (POS / Tienda Nube / Mercado Libre). Con uno solo filtra el servidor;
// con varios se traen todas y se filtra acá. Vacío = todos.
const setSourceQs = (qs, f) => { if (f.sources?.length === 1) qs.set('source', f.sources[0]); };
const keepSources = (f) => (rows) => (f.sources?.length > 1 ? (rows || []).filter(s => f.sources.includes(s.source || 'pos')) : rows);
// Proveedores elegidos (vacío = todos).
const supplierOk = (f, supplierId) => !f.supplierIds?.length || f.supplierIds.includes(String(supplierId));
const nameOf = (c) => `${c.name || ''} ${c.lastname || ''}`.trim();

async function repSales(f = {}) {
  const qs = new URLSearchParams({ status: 'confirmed', limit: '100000' });
  if (f.from) qs.set('from', f.from + 'T00:00:00');
  if (f.to) qs.set('to', f.to + 'T23:59:59');
  if (f.branchId) qs.set('branchId', f.branchId);
  setSourceQs(qs, f);
  const [sales, employees, products, categories, branches] = await Promise.all([
    api('/api/sales?' + qs.toString()).then(keepSources(f)),
    Employees.list(), Products.list(), getAll('categories'), getBranches(),
  ]);
  const emMap = Object.fromEntries((employees || []).map(e => [e.id, nameOf(e)]));
  const catMap = Object.fromEntries((categories || []).map(c => [c.id, c.name]));
  const brMap = Object.fromEntries((branches || []).map(b => [b.id, b.name]));
  const vMap = {};
  for (const p of (products || [])) {
    for (const v of (p.variants || [])) {
      vMap[v.id] = { code: v.code || p.code || '', category: catMap[p.category_id] || '', supplierId: p.supplier_id || null };
    }
  }
  const match = (it) => supplierOk(f, vMap[it.variantId]?.supplierId);
  const header = [];
  const details = [];
  for (const s of (sales || [])) {
    const items = (s.items || []).filter(match);
    if (f.supplierIds?.length && !items.length) continue; // con filtro de proveedor, sólo ventas que lo incluyan
    const importe = round2(items.reduce((n, it) => n + (it.subtotal || 0), 0));
    const costo = round2(items.reduce((n, it) => n + (it.costSnapshot || 0) * (it.qty || 0), 0));
    header.push({
      Numero: s.number, Fecha: fmtDateTime(s.datetime), Sucursal: brMap[s.branchId] || s.branchId,
      Cliente: s.customer?.name || '', Vendedor: emMap[s.sellerId] || '',
      Origen: s.source === 'tn' ? 'Tienda Nube' : s.source === 'ml' ? 'Mercado Libre' : 'POS',
      Items: items.length, Importe: importe, Costo: costo, Ganancia: round2(importe - costo),
      'Margen %': importe ? round2(((importe - costo) / importe) * 100) : 0, Total: s.total,
      Pagos: (s.payments || []).map(p => `${p.methodName || p.methodId}: ${p.amount}`).join(' · '),
    });
    for (const it of items) {
      const info = vMap[it.variantId] || {};
      const variante = it.variantNameSnap && it.variantNameSnap !== 'default' ? ` (${it.variantNameSnap})` : '';
      const sub = it.subtotal || 0, cost = round2((it.costSnapshot || 0) * (it.qty || 0));
      details.push({
        Numero: s.number, Fecha: fmtDate(s.datetime), Producto: `${it.productNameSnap}${variante}`,
        Codigo: info.code || '', Categoria: info.category || '', Cantidad: it.qty,
        Precio: it.unitPrice, Costo: it.costSnapshot, Subtotal: sub,
        Ganancia: round2(sub - cost), 'Margen %': sub ? round2(((sub - cost) / sub) * 100) : 0,
      });
    }
  }
  if (header.length) {
    const t = header.reduce((a, r) => { a.Items += r.Items; a.Importe = round2(a.Importe + r.Importe); a.Costo = round2(a.Costo + r.Costo); a.Ganancia = round2(a.Ganancia + r.Ganancia); a.Total = round2(a.Total + (Number(r.Total) || 0)); return a; }, { Items: 0, Importe: 0, Costo: 0, Ganancia: 0, Total: 0 });
    header.push({ Numero: 'TOTAL', Fecha: '', Sucursal: '', Cliente: '', Vendedor: '', Origen: '', Items: t.Items, Importe: t.Importe, Costo: t.Costo, Ganancia: t.Ganancia, 'Margen %': t.Importe ? round2((t.Ganancia / t.Importe) * 100) : 0, Total: t.Total, Pagos: '' });
  }
  return saveXLSX('reporte_ventas.xlsx', [
    { name: 'Ventas', rows: header }, { name: 'Detalle items', rows: details },
  ]);
}

// ---------- Reportes agrupados de ventas (período mensual/anual) ----------
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const unidadesDe = (s) => (s.items || []).reduce((n, it) => n + (it.qty || 0), 0);
// Costo de mercadería de una venta (snapshot de cada ítem × cantidad).
const saleCost = (s) => round2((s.items || []).reduce((n, it) => n + (it.costSnapshot || 0) * (it.qty || 0), 0));

// Trae ventas (con filtros) + mapas de variante→producto/rubro/proveedor y de cliente/sucursal.
async function salesContext(f = {}) {
  const qs = new URLSearchParams({ status: 'confirmed', limit: '100000' });
  if (f.from) qs.set('from', f.from + 'T00:00:00');
  if (f.to) qs.set('to', f.to + 'T23:59:59');
  if (f.branchId) qs.set('branchId', f.branchId);
  setSourceQs(qs, f);
  const [sales, customers, products, categories, suppliers, branches] = await Promise.all([
    api('/api/sales?' + qs.toString()).then(keepSources(f)),
    api('/api/customers').catch(() => []),
    Products.list(), getAll('categories'), Suppliers.list().catch(() => []), getBranches(),
  ]);
  const catMap = Object.fromEntries((categories || []).map(c => [c.id, c.name]));
  const suMap = Object.fromEntries((suppliers || []).map(s => [s.id, s.name]));
  const brMap = Object.fromEntries((branches || []).map(b => [b.id, b.name]));
  const cuMap = Object.fromEntries((customers || []).map(c => [c.id, c]));
  const vMap = {};
  for (const p of (products || [])) {
    const info = { productId: p.id, nombre: p.name, categoria: catMap[p.category_id] || 'Sin rubro', proveedor: suMap[p.supplier_id] || 'Sin proveedor', supplierId: p.supplier_id || null };
    for (const v of (p.variants || [])) vMap[v.id] = { ...info, code: v.code || p.code || '' };
  }
  return { sales: sales || [], vMap, catMap, suMap, brMap, cuMap };
}

async function repBySeller(f = {}) {
  const { sales } = await salesContext(f);
  const g = new Map();
  let gran = 0;
  for (const s of sales) {
    const k = s.sellerName || 'Sin vendedor';
    const e = g.get(k) || { Vendedor: k, Ventas: 0, Unidades: 0, Importe: 0, Costo: 0 };
    e.Ventas += 1; e.Unidades += unidadesDe(s);
    e.Importe = round2(e.Importe + (s.total || 0));
    e.Costo = round2(e.Costo + saleCost(s));
    gran += s.total || 0;
    g.set(k, e);
  }
  gran = round2(gran);
  const rows = [...g.values()].map(e => {
    const gan = round2(e.Importe - e.Costo);
    return {
      Vendedor: e.Vendedor, Ventas: e.Ventas, Unidades: e.Unidades, Importe: e.Importe,
      'Ticket prom.': e.Ventas ? round2(e.Importe / e.Ventas) : 0, Costo: e.Costo, Ganancia: gan,
      'Margen %': e.Importe ? round2((gan / e.Importe) * 100) : 0, 'Part. %': gran ? round2((e.Importe / gran) * 100) : 0,
    };
  }).sort((a, b) => b.Importe - a.Importe);
  if (rows.length) {
    const t = rows.reduce((a, r) => { a.Ventas += r.Ventas; a.Unidades += r.Unidades; a.Importe = round2(a.Importe + r.Importe); a.Costo = round2(a.Costo + r.Costo); a.Ganancia = round2(a.Ganancia + r.Ganancia); return a; }, { Ventas: 0, Unidades: 0, Importe: 0, Costo: 0, Ganancia: 0 });
    rows.push({ Vendedor: 'TOTAL', Ventas: t.Ventas, Unidades: t.Unidades, Importe: t.Importe, 'Ticket prom.': '', Costo: t.Costo, Ganancia: t.Ganancia, 'Margen %': t.Importe ? round2((t.Ganancia / t.Importe) * 100) : 0, 'Part. %': 100 });
  }
  return saveXLSX('ventas_por_vendedor.xlsx', [{ name: 'Por vendedor', rows }]);
}

async function repByCustomerSum(f = {}) {
  const { sales, cuMap } = await salesContext(f);
  const g = new Map();
  let gran = 0;
  for (const s of sales) {
    const c = s.customerId ? cuMap[s.customerId] : null;
    const k = s.customerId || '__sin__';
    const e = g.get(k) || { Cliente: c ? nameOf(c) : 'Sin cliente', Documento: c ? docOf(c) : '', Ventas: 0, Unidades: 0, Importe: 0, Costo: 0, _last: '' };
    e.Ventas += 1; e.Unidades += unidadesDe(s);
    e.Importe = round2(e.Importe + (s.total || 0));
    e.Costo = round2(e.Costo + saleCost(s));
    if (String(s.datetime) > e._last) e._last = String(s.datetime);
    gran += s.total || 0;
    g.set(k, e);
  }
  gran = round2(gran);
  const rows = [...g.values()].map(e => {
    const gan = round2(e.Importe - e.Costo);
    return {
      Cliente: e.Cliente, Documento: e.Documento, Ventas: e.Ventas, Unidades: e.Unidades, Importe: e.Importe,
      'Ticket prom.': e.Ventas ? round2(e.Importe / e.Ventas) : 0, Ganancia: gan,
      'Margen %': e.Importe ? round2((gan / e.Importe) * 100) : 0, 'Part. %': gran ? round2((e.Importe / gran) * 100) : 0,
      'Última compra': e._last ? fmtDate(e._last) : '',
    };
  }).sort((a, b) => b.Importe - a.Importe);
  if (rows.length) {
    const t = rows.reduce((a, r) => { a.Ventas += r.Ventas; a.Unidades += r.Unidades; a.Importe = round2(a.Importe + r.Importe); a.Ganancia = round2(a.Ganancia + r.Ganancia); return a; }, { Ventas: 0, Unidades: 0, Importe: 0, Ganancia: 0 });
    rows.push({ Cliente: 'TOTAL', Documento: '', Ventas: t.Ventas, Unidades: t.Unidades, Importe: t.Importe, 'Ticket prom.': '', Ganancia: t.Ganancia, 'Margen %': t.Importe ? round2((t.Ganancia / t.Importe) * 100) : 0, 'Part. %': 100, 'Última compra': '' });
  }
  return saveXLSX('ventas_por_cliente.xlsx', [{ name: 'Por cliente', rows }]);
}

// Agrupa los ITEMS de venta por una dimensión del producto (proveedor o rubro).
// Enriquecido: ventas, unidades, productos, importe, costo, ganancia, margen y participación,
// con fila TOTAL. supplierId (opcional) filtra a un proveedor.
function groupItemsBy(sales, vMap, dimKey, label, f = {}) {
  const g = new Map();
  let granImporte = 0;
  for (const s of sales) for (const it of (s.items || [])) {
    const info = vMap[it.variantId] || {};
    if (!supplierOk(f, info.supplierId)) continue;
    const k = info[dimKey] || `Sin ${label.toLowerCase()}`;
    const e = g.get(k) || { [label]: k, Unidades: 0, Importe: 0, Costo: 0, _prods: new Set(), _sales: new Set() };
    const sub = it.subtotal || 0;
    e.Unidades += it.qty || 0;
    e.Importe = round2(e.Importe + sub);
    e.Costo = round2(e.Costo + (it.costSnapshot || 0) * (it.qty || 0));
    if (info.productId) e._prods.add(info.productId);
    e._sales.add(s.id);
    granImporte += sub;
    g.set(k, e);
  }
  granImporte = round2(granImporte);
  const rows = [...g.values()].map(e => {
    const ganancia = round2(e.Importe - e.Costo);
    return {
      [label]: e[label], Ventas: e._sales.size, Unidades: e.Unidades, Productos: e._prods.size,
      Importe: e.Importe, 'Ticket prom.': e._sales.size ? round2(e.Importe / e._sales.size) : 0,
      Costo: e.Costo, Ganancia: ganancia, 'Margen %': e.Importe ? round2((ganancia / e.Importe) * 100) : 0,
      'Part. %': granImporte ? round2((e.Importe / granImporte) * 100) : 0,
    };
  }).sort((a, b) => b.Importe - a.Importe);
  if (rows.length) {
    const t = rows.reduce((a, r) => { a.Unidades += r.Unidades; a.Importe = round2(a.Importe + r.Importe); a.Costo = round2(a.Costo + r.Costo); a.Ganancia = round2(a.Ganancia + r.Ganancia); return a; }, { Unidades: 0, Importe: 0, Costo: 0, Ganancia: 0 });
    rows.push({
      [label]: 'TOTAL', Ventas: '', Unidades: t.Unidades, Productos: '', Importe: t.Importe,
      'Ticket prom.': '', Costo: t.Costo, Ganancia: t.Ganancia,
      'Margen %': t.Importe ? round2((t.Ganancia / t.Importe) * 100) : 0, 'Part. %': 100,
    });
  }
  return rows;
}

// Detalle por PRODUCTO vendido (una fila por variante/SKU): cantidad, precio, costo, margen.
// supplierId (opcional) filtra a un proveedor. Ordena por importe desc, con fila TOTAL.
function productDetail(sales, vMap, f = {}) {
  const g = new Map(); // variantId -> agregado
  for (const s of sales) for (const it of (s.items || [])) {
    const info = vMap[it.variantId] || {};
    if (!supplierOk(f, info.supplierId)) continue;
    const variante = it.variantNameSnap && it.variantNameSnap !== 'default' ? ` (${it.variantNameSnap})` : '';
    const e = g.get(it.variantId) || {
      Proveedor: info.proveedor || 'Sin proveedor', Rubro: info.categoria || 'Sin rubro',
      Codigo: info.code || '', Producto: `${it.productNameSnap || info.nombre || ''}${variante}`,
      Cantidad: 0, Importe: 0, CostoTotal: 0,
    };
    e.Cantidad += it.qty || 0;
    e.Importe = round2(e.Importe + (it.subtotal || 0));
    e.CostoTotal = round2(e.CostoTotal + (it.costSnapshot || 0) * (it.qty || 0));
    g.set(it.variantId, e);
  }
  const rows = [...g.values()].map(e => {
    const ganancia = round2(e.Importe - e.CostoTotal);
    return {
      Proveedor: e.Proveedor, Rubro: e.Rubro, Codigo: e.Codigo, Producto: e.Producto,
      Cantidad: e.Cantidad,
      'Precio unit.': e.Cantidad ? round2(e.Importe / e.Cantidad) : 0,
      Importe: e.Importe,
      'Costo unit.': e.Cantidad ? round2(e.CostoTotal / e.Cantidad) : 0,
      Costo: e.CostoTotal,
      Ganancia: ganancia,
      'Margen %': e.Importe ? round2((ganancia / e.Importe) * 100) : 0,
    };
  }).sort((a, b) => b.Importe - a.Importe);
  if (rows.length) {
    const t = rows.reduce((a, r) => { a.Cantidad += r.Cantidad; a.Importe = round2(a.Importe + r.Importe); a.Costo = round2(a.Costo + r.Costo); a.Ganancia = round2(a.Ganancia + r.Ganancia); return a; }, { Cantidad: 0, Importe: 0, Costo: 0, Ganancia: 0 });
    rows.push({
      Proveedor: '', Rubro: '', Codigo: '', Producto: 'TOTAL', Cantidad: t.Cantidad,
      'Precio unit.': '', Importe: t.Importe, 'Costo unit.': '', Costo: t.Costo, Ganancia: t.Ganancia,
      'Margen %': t.Importe ? round2((t.Ganancia / t.Importe) * 100) : 0,
    });
  }
  return rows;
}

async function repBySupplier(f = {}) {
  const { sales, vMap } = await salesContext(f);
  return saveXLSX('ventas_por_proveedor.xlsx', [
    { name: 'Por proveedor', rows: groupItemsBy(sales, vMap, 'proveedor', 'Proveedor', f) },
    { name: 'Productos vendidos', rows: productDetail(sales, vMap, f) },
  ]);
}

async function repByCategory(f = {}) {
  const { sales, vMap } = await salesContext(f);
  return saveXLSX('ventas_por_rubro.xlsx', [{ name: 'Por rubro', rows: groupItemsBy(sales, vMap, 'categoria', 'Rubro', f) }]);
}

// Nombre de hoja válido para Excel: sin \ / ? * [ ] :  y máx 31 chars.
const sheetSafe = (s) => String(s || 'Sin dato').replace(/[\\/?*\[\]:]/g, ' ').trim().slice(0, 31) || 'Hoja';

async function repByPayment(f = {}) {
  const { sales, brMap } = await salesContext(f);
  const perMethod = new Map();
  const resumen = new Map();
  for (const s of sales) for (const p of (s.payments || [])) {
    // Señas y vales guardan su número en el nombre: se agrupan en una sola fila.
    const k = p.methodId === 'sena' ? 'Seña (ya cobrada)' : p.methodId === 'credit_note' ? 'Vale' : (p.methodName || p.methodId || 'Sin método');
    if (!perMethod.has(k)) perMethod.set(k, []);
    perMethod.get(k).push({
      Numero: s.number, Fecha: fmtDateTime(s.datetime), Sucursal: brMap[s.branchId] || s.branchId,
      Cliente: s.customer?.name || '', Vendedor: s.sellerName || '', Monto: round2(p.amount || 0), TotalVenta: s.total || 0,
    });
    const r = resumen.get(k) || { Medio: k, Pagos: 0, Total: 0 };
    r.Pagos += 1; r.Total = round2(r.Total + (p.amount || 0));
    resumen.set(k, r);
  }
  const resOrd = [...resumen.values()].sort((a, b) => b.Total - a.Total);
  const gran = round2(resOrd.reduce((n, r) => n + (r.Total || 0), 0));
  const resumenRows = resOrd.map(r => ({ Medio: r.Medio, Pagos: r.Pagos, Total: r.Total, 'Part. %': gran ? round2((r.Total / gran) * 100) : 0 }));
  if (resumenRows.length) resumenRows.push({ Medio: 'TOTAL', Pagos: resumenRows.reduce((n, r) => n + (Number(r.Pagos) || 0), 0), Total: gran, 'Part. %': 100 });
  const sheets = [{ name: 'Resumen', rows: resumenRows }];
  for (const [k, rows] of perMethod) sheets.push({ name: sheetSafe(k), rows });
  return saveXLSX('ventas_por_medio_pago.xlsx', sheets);
}

async function repProfit(f = {}) {
  const { sales, brMap } = await salesContext(f);
  const perSale = [];
  const byMedio = new Map(), byBank = new Map(), byCanal = new Map(), byAcred = new Map();
  const g = (map, key, seed) => { if (!map.has(key)) map.set(key, seed()); return map.get(key); };
  const pctAmt = (p, k) => (p.costMeta && p.costMeta[k]) ? (p.amount || 0) * p.costMeta[k] / 100 : 0;
  for (const s of sales) {
    const ingreso = s.total || 0;
    const costoMerc = round2((s.items || []).reduce((n, it) => n + (it.costSnapshot || 0) * (it.qty || 0), 0));
    const pays = s.payments || [];
    const costoPagos = round2(pays.reduce((n, p) => n + (p.costMeta?.costAmount || 0), 0));
    const ganancia = round2(ingreso - costoMerc - costoPagos);
    const canal = s.source === 'tn' ? 'Tienda Nube' : s.source === 'ml' ? 'Mercado Libre' : 'POS';
    const cm0 = pays.find((p) => p.costMeta)?.costMeta || null;
    perSale.push({
      Numero: s.number, Fecha: fmtDateTime(s.datetime), Sucursal: brMap[s.branchId] || s.branchId, Canal: canal,
      Banco: cm0?.bank || '', Medio: pays.map((p) => p.methodName).join(' + '), Cuotas: cm0?.installments || 1,
      Ingreso: ingreso, CostoMercaderia: costoMerc,
      Comision: round2(pays.reduce((n, p) => n + pctAmt(p, 'commissionPct'), 0)),
      Financiero: round2(pays.reduce((n, p) => n + pctAmt(p, 'financingPct'), 0)),
      Plataforma: round2(pays.reduce((n, p) => n + pctAmt(p, 'platformPct'), 0)),
      CostoPagos: costoPagos, Ganancia: ganancia, MargenPct: ingreso ? round2((ganancia / ingreso) * 100) : 0,
    });
    for (const p of pays) {
      const cm = p.costMeta || {};
      const merchShare = round2(costoMerc * (ingreso ? (p.amount || 0) / ingreso : 0));
      const cost = round2(cm.costAmount || 0);
      const gan = round2((p.amount || 0) - merchShare - cost);
      const acc = (map, key, label, field) => { const e = g(map, key, () => ({ [field]: label, Pagos: 0, Ingreso: 0, Costo: 0, Ganancia: 0 })); e.Pagos++; e.Ingreso = round2(e.Ingreso + (p.amount || 0)); e.Costo = round2(e.Costo + cost); e.Ganancia = round2(e.Ganancia + gan); };
      acc(byMedio, p.methodName || '—', p.methodName || '—', 'Medio');
      acc(byBank, cm.bank || '(sin banco)', cm.bank || '(sin banco)', 'Banco');
      acc(byCanal, canal, canal, 'Canal');
      if (cm.creditDate) { const d = String(cm.creditDate).slice(0, 10); const e = g(byAcred, d, () => ({ Fecha: d, Pagos: 0, Neto: 0 })); e.Pagos++; e.Neto = round2(e.Neto + ((p.amount || 0) - cost)); }
    }
  }
  const byGan = (arr) => arr.sort((a, b) => b.Ganancia - a.Ganancia);
  return saveXLSX('ganancia.xlsx', [
    { name: 'Por venta', rows: perSale },
    { name: 'Por medio', rows: byGan([...byMedio.values()]) },
    { name: 'Por banco', rows: byGan([...byBank.values()]) },
    { name: 'Por canal', rows: byGan([...byCanal.values()]) },
    { name: 'Acreditaciones', rows: [...byAcred.values()].sort((a, b) => String(a.Fecha).localeCompare(String(b.Fecha))) },
  ]);
}

async function repStockSnapshot(f = {}) {
  if (!f.from || !f.to) { toast('Elegí un período', 'warn'); return 0; }
  const qs = new URLSearchParams({ from: f.from, to: f.to });
  if (f.branchId) qs.set('branchId', f.branchId);
  const [snap, products, categories, branches] = await Promise.all([
    api('/api/reports/stock-snapshot?' + qs.toString()),
    Products.list(), getAll('categories'), getBranches(),
  ]);
  const catMap = Object.fromEntries((categories || []).map(c => [c.id, c.name]));
  const brMap = Object.fromEntries((branches || []).map(b => [b.id, b.name]));
  const vMap = {};
  for (const p of (products || [])) for (const v of (p.variants || [])) {
    vMap[v.id] = { code: v.code || p.code || '', nombre: p.name, rubro: catMap[p.category_id] || 'Sin rubro', productId: p.id };
  }
  // Agregar por producto (suma de variantes y, sin filtro de sucursal, de ambas sucursales).
  const g = new Map();
  for (const r of (snap.rows || [])) {
    const info = vMap[r.variantId]; if (!info) continue;
    const e = g.get(info.productId) || { Codigo: info.code, Producto: info.nombre, Rubro: info.rubro, StockInicial: 0, StockFinal: 0, MovPeriodo: 0 };
    e.StockInicial += r.inicial; e.StockFinal += r.final; e.MovPeriodo += r.movPeriodo;
    g.set(info.productId, e);
  }
  const rows = [...g.values()].filter(e => e.StockInicial || e.StockFinal || e.MovPeriodo)
    .sort((a, b) => String(a.Producto).localeCompare(String(b.Producto)));
  const suc = f.branchId ? (brMap[f.branchId] || f.branchId) : 'Todas';
  const fuente = (x) => x === 'snapshot' ? 'Foto mensual (exacto)' : 'Reconstruido (estimado)';
  const info = [
    { Dato: 'Período', Valor: `${f.from} a ${f.to}` },
    { Dato: 'Sucursal', Valor: suc },
    { Dato: 'Stock inicial', Valor: fuente(snap.source?.inicial) },
    { Dato: 'Stock final', Valor: fuente(snap.source?.final) },
  ];
  return saveXLSX(`stock_inicial_final_${f.from}_a_${f.to}.xlsx`, [
    { name: sheetSafe(`Stock ${suc}`), rows },
    { name: 'Info', rows: info },
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
    let suppliers = [];
    if (has('supplier')) { try { suppliers = await Suppliers.list(); } catch { suppliers = []; } }
    // Sucursal: el admin arranca con la suya marcada; puede marcar otra o varias (varias = un
    // archivo por sucursal) o ninguna (= todas juntas). El encargado queda ceñido a la suya.
    const sel = { branches: activeBranchId() ? [activeBranchId()] : [], sources: [], suppliers: [] };
    const myBranch = branches.find(b => b.id === activeBranchId());
    const parts = [];
    const now = new Date();
    const curMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    if (has('period')) parts.push(`
      <label class="block"><span class="text-xs font-bold text-[#7d6c5c]">Período</span>
        <select id="rf-pmode" class="ing-input w-full mt-1">
          <option value="month">Mensual</option>
          <option value="year">Anual</option>
          <option value="range">Rango</option>
        </select></label>
      <div id="rf-pmonth-wrap"><label class="block"><span class="text-xs font-bold text-[#7d6c5c]">Mes</span>
        <input id="rf-pmonth" type="month" class="ing-input w-full mt-1" value="${curMonth}" /></label></div>
      <div id="rf-pyear-wrap" class="hidden"><label class="block"><span class="text-xs font-bold text-[#7d6c5c]">Año</span>
        <input id="rf-pyear" type="number" min="2020" max="2100" class="ing-input w-full mt-1" value="${now.getFullYear()}" /></label></div>
      <div id="rf-prange-wrap" class="col-span-2 hidden grid grid-cols-2 gap-3">
        <label class="block"><span class="text-xs font-bold text-[#7d6c5c]">Desde</span>
          <input id="rf-pfrom" type="date" class="ing-input w-full mt-1" /></label>
        <label class="block"><span class="text-xs font-bold text-[#7d6c5c]">Hasta</span>
          <input id="rf-pto" type="date" class="ing-input w-full mt-1" /></label>
      </div>`);
    if (has('date')) parts.push(`
      <label class="block"><span class="text-xs font-bold text-[#7d6c5c]">Desde</span>
        <input id="rf-from" type="date" class="ing-input w-full mt-1" /></label>
      <label class="block"><span class="text-xs font-bold text-[#7d6c5c]">Hasta</span>
        <input id="rf-to" type="date" class="ing-input w-full mt-1" /></label>`);
    if (has('branch')) parts.push(`
      <div class="block"><span class="text-xs font-bold text-[#7d6c5c]">Sucursal</span>
        <div class="mt-1">${admin ? multiFilterHtml('rf-branches', 'Sucursal', sel.branches.length, { full: true }) : `<div class="ing-input w-full opacity-80">${escHtml(myBranch?.name || '')}</div>`}</div>
        ${admin ? '<p class="text-[11px] text-[#7d6c5c] mt-1">Varias = un archivo por sucursal. Ninguna = todas juntas.</p>' : ''}</div>`);
    if (has('source')) parts.push(`
      <div class="block"><span class="text-xs font-bold text-[#7d6c5c]">Origen</span>
        <div class="mt-1">${multiFilterHtml('rf-sources', 'Todos', 0, { full: true })}</div></div>`);
    if (has('supplier')) parts.push(`
      <div class="block col-span-2"><span class="text-xs font-bold text-[#7d6c5c]">Proveedor</span>
        <div class="mt-1">${multiFilterHtml('rf-suppliers', 'Todos', 0, { full: true })}</div></div>`);
    if (has('customer')) parts.push(`
      <label class="block col-span-2"><span class="text-xs font-bold text-[#7d6c5c]">Cliente (nombre o documento, opcional)</span>
        <input id="rf-term" class="ing-input w-full mt-1" placeholder="Dejar vacío = todos los clientes" /></label>
      <label class="col-span-2 flex items-center gap-2 mt-1 text-sm">
        <input id="rf-onlycust" type="checkbox" checked class="w-4 h-4" />
        <span>Solo compras con cliente identificado</span></label>`);
    // Filtro por columnas: OPCIONAL. Por defecto desactivado → al tocar Generar baja directo.
    parts.push(`
      <label class="col-span-2 flex items-center gap-2 mt-1 text-sm border-t border-[#fff1e6] pt-3">
        <input id="rf-colfilter" type="checkbox" class="w-4 h-4" />
        <span>Filtrar por columnas antes de bajar (opcional)</span></label>`);
    openModal({
      title, size: 'md',
      bodyHTML: `<div class="grid grid-cols-2 gap-3">${parts.join('')}</div>
        <p class="text-xs text-[#7d6c5c] mt-3">Las fechas vacías = sin límite.</p>`,
      footerHTML: `<button class="ing-btn-secondary" data-act="cancel">Cancelar</button>
                   <button class="ing-btn-primary" data-act="ok"><span class="material-symbols-outlined text-sm align-middle">download</span> Generar</button>`,
      onOpen: (el, close) => {
        const g = (id) => el.querySelector(id);
        if (has('branch') && admin) mountMultiFilter(el, 'rf-branches', { options: branches.map(b => ({ id: b.id, name: b.name })), selected: sel.branches, onChange: (v) => { sel.branches = v; } });
        if (has('source')) mountMultiFilter(el, 'rf-sources', { options: [
          { id: 'pos', name: 'POS (local)' }, { id: 'tn', name: 'Tienda Nube' }, { id: 'ml', name: 'Mercado Libre' },
        ], selected: sel.sources, onChange: (v) => { sel.sources = v; } });
        if (has('supplier')) mountMultiFilter(el, 'rf-suppliers', { options: [...suppliers].sort((a, b) => String(a.name).localeCompare(String(b.name), 'es')).map(s => ({ id: String(s.id), name: s.name })),
          selected: sel.suppliers, onChange: (v) => { sel.suppliers = v; }, searchPlaceholder: 'Buscar proveedor…' });
        if (has('period')) {
          const sync = () => {
            const m = g('#rf-pmode').value;
            g('#rf-pmonth-wrap').classList.toggle('hidden', m !== 'month');
            g('#rf-pyear-wrap').classList.toggle('hidden', m !== 'year');
            g('#rf-prange-wrap').classList.toggle('hidden', m !== 'range');
          };
          g('#rf-pmode').addEventListener('change', sync); sync();
        }
        const periodRange = () => {
          const m = g('#rf-pmode').value;
          if (m === 'year') { const y = parseInt(g('#rf-pyear').value) || now.getFullYear(); return { from: `${y}-01-01`, to: `${y}-12-31` }; }
          if (m === 'range') return { from: g('#rf-pfrom').value || undefined, to: g('#rf-pto').value || undefined };
          const v = g('#rf-pmonth').value || curMonth;
          const [yy, mm] = v.split('-').map(Number);
          const last = new Date(yy, mm, 0).getDate();
          return { from: `${v}-01`, to: `${v}-${String(last).padStart(2, '0')}` };
        };
        el.querySelector('[data-act="cancel"]').addEventListener('click', () => close(null));
        el.querySelector('[data-act="ok"]').addEventListener('click', () => {
          const pr = has('period') ? periodRange() : {};
          const brs = has('branch') ? (admin ? sel.branches : [activeBranchId()].filter(Boolean)) : [];
          const branchesSeparate = brs.length > 1;
          const brVal = brs.length === 1 ? brs[0] : undefined;
          close({
            from: has('period') ? pr.from : (has('date') ? (g('#rf-from').value || undefined) : undefined),
            to: has('period') ? pr.to : (has('date') ? (g('#rf-to').value || undefined) : undefined),
            branchId: branchesSeparate ? undefined : (brVal || undefined),
            branchesSeparate,
            branchIdsPicked: branchesSeparate ? brs : undefined,
            supplierIds: has('supplier') ? sel.suppliers : [],
            sources: has('source') ? sel.sources : [],
            term: has('customer') ? g('#rf-term').value.trim().toLowerCase() : '',
            onlyWithCustomer: has('customer') ? g('#rf-onlycust').checked : false,
            columnFilter: !!(g('#rf-colfilter') && g('#rf-colfilter').checked),
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
  setSourceQs(qs, f);
  const [sales, customers, products, categories, branches] = await Promise.all([
    api('/api/sales?' + qs.toString()).then(keepSources(f)),
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
        Sucursal: brMap[s.branchId] || s.branchId, Origen: s.source === 'tn' ? 'Tienda Nube' : s.source === 'ml' ? 'Mercado Libre' : 'POS',
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
  if (rows.length) rows.push({ Numero: 'TOTAL', Fecha: '', Cliente: '', Devuelve: round2(rows.reduce((n, r) => n + (Number(r.Devuelve) || 0), 0)), Lleva: round2(rows.reduce((n, r) => n + (Number(r.Lleva) || 0), 0)), 'Diferencia (+cobrado / -devuelto)': round2(rows.reduce((n, r) => n + (Number(r['Diferencia (+cobrado / -devuelto)']) || 0), 0)), Vale: '', Motivo: '' });
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
  if (rows.length) rows.push({ Fecha: 'TOTAL', Sucursal: '', Tipo: '', Descripcion: '', Entra: round2(rows.reduce((n, r) => n + (Number(r.Entra) || 0), 0)), Sale: round2(rows.reduce((n, r) => n + (Number(r.Sale) || 0), 0)), Saldo: '' });
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
  if (rows.length) rows.push({ Fecha: 'TOTAL', Sucursal: '', Categoria: '', Descripcion: '', Medio: '', Monto: round2(rows.reduce((n, r) => n + (Number(r.Monto) || 0), 0)) });
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

async function repInventory(f = {}) {
  const [products, stocks, categories, brands, suppliers, branches] = await Promise.all([
    Products.list(), Products.listStock(), getAll('categories'), getAll('brands'), getAll('suppliers'), getBranches(),
  ]);
  const catMap = Object.fromEntries((categories || []).map(c => [c.id, c.name]));
  const brMap = Object.fromEntries((brands || []).map(b => [b.id, b.name]));
  const spMap = Object.fromEntries((suppliers || []).map(s => [s.id, s.name]));
  let prods = (products || []);
  if (f.supplierIds?.length) prods = prods.filter(p => supplierOk(f, p.supplier_id));
  const rows = prods.map(p => {
    const row = {
      Codigo: p.code, Nombre: p.name, Categoria: catMap[p.category_id] || '', Marca: brMap[p.brand_id] || '',
      Proveedor: spMap[p.supplier_id] || '', Costo: p.cost,
      'Gan. unit.': round2((Number(p.price) || 0) - (Number(p.cost) || 0)), 'Margen %': p.margin_pct,
      Precio: p.price, MELI: p.published_meli ? 'Sí' : 'No',
    };
    let total = 0;
    for (const b of (branches || [])) {
      const s = (stocks || []).find(x => x.product_id === p.id && x.branch_id === b.id);
      row[b.name] = s?.qty || 0;
      total += s?.qty || 0;
    }
    row.StockTotal = total;
    row.ValorizacionCosto = round2(total * (Number(p.cost) || 0));
    row.ValorizacionVenta = round2(total * (Number(p.price) || 0));
    row['Gan. potencial'] = round2(row.ValorizacionVenta - row.ValorizacionCosto);
    return row;
  });
  const granCosto = round2(rows.reduce((n, r) => n + (Number(r.ValorizacionCosto) || 0), 0));
  for (const r of rows) r['Part. % valorizado'] = granCosto ? round2((r.ValorizacionCosto / granCosto) * 100) : 0;
  rows.sort((a, b) => b.ValorizacionCosto - a.ValorizacionCosto);
  if (rows.length) {
    const t = rows.reduce((a, r) => { a.StockTotal += r.StockTotal; a.VC = round2(a.VC + (Number(r.ValorizacionCosto) || 0)); a.VV = round2(a.VV + (Number(r.ValorizacionVenta) || 0)); a.GP = round2(a.GP + (Number(r['Gan. potencial']) || 0)); return a; }, { StockTotal: 0, VC: 0, VV: 0, GP: 0 });
    const totalRow = { Codigo: '', Nombre: 'TOTAL', Categoria: '', Marca: '', Proveedor: '', Costo: '', 'Gan. unit.': '', 'Margen %': '', Precio: '', MELI: '' };
    for (const b of (branches || [])) totalRow[b.name] = '';
    totalRow.StockTotal = t.StockTotal; totalRow.ValorizacionCosto = t.VC; totalRow.ValorizacionVenta = t.VV;
    totalRow['Gan. potencial'] = t.GP; totalRow['Part. % valorizado'] = 100;
    rows.push(totalRow);
  }
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
  const granCosto = round2(Object.values(byCat).reduce((n, v) => n + (v.cost || 0), 0));
  const rows = Object.entries(byCat).map(([c, v]) => ({
    Categoria: catMap[c] || c, SKUs: v.items, Unidades: v.qty, ValorCosto: round2(v.cost), ValorVenta: round2(v.price),
    MargenPot: round2(v.price - v.cost), 'Part. % valorizado': granCosto ? round2((v.cost / granCosto) * 100) : 0,
  })).sort((a, b) => b.ValorCosto - a.ValorCosto);
  if (rows.length) {
    const t = rows.reduce((a, r) => { a.SKUs += r.SKUs; a.Unidades += r.Unidades; a.VC = round2(a.VC + r.ValorCosto); a.VV = round2(a.VV + r.ValorVenta); return a; }, { SKUs: 0, Unidades: 0, VC: 0, VV: 0 });
    rows.push({ Categoria: 'TOTAL', SKUs: t.SKUs, Unidades: t.Unidades, ValorCosto: t.VC, ValorVenta: t.VV, MargenPot: round2(t.VV - t.VC), 'Part. % valorizado': 100 });
  }
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
  if (rows.length) rows.push({ Numero: 'TOTAL', Proveedor: '', Banco: '', Emision: '', Vence: '', Monto: round2(rows.reduce((n, r) => n + (Number(r.Monto) || 0), 0)), Estado: '', Nota: '' });
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
  if (rows.length) rows.push({ Nombre: 'TOTAL', Sucursal: '', Rol: '', Activo: '', HsMes: round2(rows.reduce((n, r) => n + (Number(r.HsMes) || 0), 0)), RateHora: '', PagoEstimado: round2(rows.reduce((n, r) => n + (Number(r.PagoEstimado) || 0), 0)) });
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
