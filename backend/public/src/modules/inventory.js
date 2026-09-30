// Inventario — módulo completo.
// Tabs: Productos | Categorías | Marcas | Proveedores | Subcategorías | Transferencias.
// Productos: grilla con filtros, mostrar/ocultar columnas, edición inline (doble-click), bulk actions.

import * as P from '../repos/products.js';
import { api } from '../core/api.js';
import { Categories, Brands, Suppliers, Subcategories } from '../repos/catalog.js';
import { getAll, newId, put, del, tx, stockId, get } from '../core/db.js';
import { money } from '../core/format.js';
import { openModal, confirmModal } from '../components/modal.js';
import { toast } from '../core/notifications.js';
import { activeBranchId, currentSession } from '../core/auth.js';
import * as Audit from '../core/audit.js';
import { exportSimple } from '../core/xlsx.js';
import { printHTML } from '../core/pdf.js';

// Escapa caracteres reservados para incrustar contenido en value="..." de un input.
function escapeAttr(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Orden alfabético (español, insensible a mayúsculas/acentos) por .name
function byName(a, b) {
  return String(a?.name ?? '').localeCompare(String(b?.name ?? ''), 'es', { sensitivity: 'base' });
}

// Combobox filtrable: input con desplegable que se puede escribir (autocompleta),
// clickear (despliega todo, en orden alfabético) y crear una opción nueva desde ahí.
// wrap = contenedor .combo-wrap (input + .combo-menu). onPick(id|'') al elegir/limpiar,
// onCreate(name) -> Promise<{id,name}> para dar de alta un registro nuevo del catálogo.
function mountCombo(wrap, { options, selectedId = '', allLabel = 'Todos', onPick, onCreate }) {
  const input = wrap.querySelector('input');
  const menu = wrap.querySelector('.combo-menu');
  if (!input || !menu) return;
  const sorted = [...(options || [])].sort(byName);
  const selected = sorted.find((o) => o.id === selectedId) || null;
  input.value = selected ? selected.name : '';

  const draw = (q = '') => {
    const needle = q.trim().toLowerCase();
    const matches = needle ? sorted.filter((o) => (o.name || '').toLowerCase().includes(needle)) : sorted;
    const exact = sorted.some((o) => (o.name || '').toLowerCase() === needle);
    const item = (id, label, extra = '') =>
      `<div class="combo-item px-3 py-2 cursor-pointer hover:bg-[#fff1e6] ${extra}" data-id="${escapeAttr(id)}">${label}</div>`;
    let html = `<div class="combo-item px-3 py-2 cursor-pointer hover:bg-[#fff1e6] italic text-[#7d6c5c]" data-id="">${allLabel}</div>`;
    html += matches.map((o) => item(o.id, escapeAttr(o.name))).join('');
    if (needle && !exact && onCreate) {
      html += `<div class="combo-item combo-create px-3 py-2 cursor-pointer hover:bg-[#fff1e6] text-[#d82f1e] font-bold" data-create="1">➕ Crear «${escapeAttr(q.trim())}»</div>`;
    }
    if (!matches.length && !needle) html += `<div class="px-3 py-2 text-[#7d6c5c] italic">Sin opciones</div>`;
    menu.innerHTML = html;
  };
  const openMenu = (q = '') => { draw(q); menu.classList.remove('hidden'); };
  const closeMenu = () => menu.classList.add('hidden');

  input.addEventListener('focus', () => { openMenu(''); setTimeout(() => input.select(), 0); });
  input.addEventListener('input', () => openMenu(input.value));
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeMenu(); input.blur(); } });
  input.addEventListener('blur', () => setTimeout(() => { if (!wrap.matches(':hover')) closeMenu(); }, 150));
  menu.addEventListener('mousedown', async (e) => {
    const it = e.target.closest('.combo-item');
    if (!it) return;
    e.preventDefault();
    if (it.dataset.create && onCreate) {
      const name = input.value.trim();
      if (!name) return;
      try { const created = await onCreate(name); closeMenu(); onPick(created?.id || ''); }
      catch { /* el repo ya avisa con toast */ }
      return;
    }
    closeMenu();
    onPick(it.dataset.id || '');
  });
}

// Parseo de número tolerante al formato argentino (1.234,56) y al plano (1234.56).
// Devuelve null si no es un número válido (para NO guardar 0 por error de formato).
function parseNumAR(s) {
  s = String(s ?? '').trim();
  if (!s) return null;
  if (s.includes(',')) {
    // Formato AR: el punto es separador de miles y la coma, decimal.
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (s.includes('.')) {
    // Sin coma: un punto seguido de 3 dígitos (o varios puntos) son miles (1.500 → 1500);
    // si son 1-2 dígitos, es decimal (1500.50 → 1500.50).
    const parts = s.split('.');
    if (parts.length > 2 || parts[parts.length - 1].length === 3) s = s.replace(/\./g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Redondeo de precio a la decena ($10). El usuario puede editarlo manualmente.
function roundPrice(x) { return Math.round((Number(x) || 0) / 10) * 10; }
// Margen (% de utilidad) real, derivado de costo y precio.
function marginOf(p) { return (p && p.cost > 0) ? ((p.price / p.cost - 1) * 100) : 0; }

// Debounce del re-render al tipear en filtros: evita reconstruir la tabla (100
// filas + detalles de variantes) en cada tecla y restaura el foco/cursor del
// input tras el render (antes se sentía "cortado" al escribir/borrar).
let _filterRenderTimer = null;
function scheduleFilterRender(container, focusId) {
  clearTimeout(_filterRenderTimer);
  _filterRenderTimer = setTimeout(() => {
    renderProducts(container);
    if (focusId) {
      const el = container.querySelector('#' + focusId);
      if (el) { el.focus(); try { el.setSelectionRange(el.value.length, el.value.length); } catch { /* noop */ } }
    }
  }, 250);
}

// Recalcula el stock agregado por sucursal (p._stocks) a partir de las variantes.
function recomputeProductStocks(p) {
  const byBranch = {};
  for (const v of (p.variants || [])) {
    for (const [bid, s] of Object.entries(v.stocks || {})) {
      const e = byBranch[bid] || { qty: 0, reserved_qty: 0 };
      e.qty += s.qty || 0; e.reserved_qty += s.reserved || 0;
      byBranch[bid] = e;
    }
  }
  p._stocks = Object.entries(byBranch).map(([branch_id, e]) => ({ product_id: p.id, branch_id, qty: e.qty, reserved_qty: e.reserved_qty }));
}

// Fila expandible con el detalle de variantes (valor, código, precio y stock
// editable por sucursal). El stock se guarda al salir de la celda y sincroniza a TN.
function variantDetailRow(p, nCols) {
  const rows = (p.variants || []).map(v => {
    const val = Object.values(v.attributes || {})[0] || (v.name && v.name !== 'default' ? v.name : '—');
    const qL = v.stocks?.br_lomas?.qty ?? 0;
    const qB = v.stocks?.br_banfield?.qty ?? 0;
    const resv = (v.stocks?.br_lomas?.reserved ?? 0) + (v.stocks?.br_banfield?.reserved ?? 0);
    const stkInput = (branch, val) => `<input type="number" min="0" step="1" value="${val}" data-vstock="${v.id}" data-vbranch="${branch}" data-pid="${p.id}" class="w-16 text-center border border-[#e3ceba] rounded-md py-0.5 focus:border-[#d82f1e] focus:ring-1 focus:ring-[#d82f1e]" />`;
    return `<tr>
      <td class="py-1 pr-4 font-bold text-[#241a0d]">${escapeAttr(val)}</td>
      <td class="py-1 pr-4 font-mono text-xs text-[#7d6c5c]">${escapeAttr(v.code || '')}</td>
      <td class="py-1 pr-4 text-right">${money(v.price_override ?? p.price)}</td>
      <td class="py-1 pr-2 text-center">${stkInput('br_lomas', qL)}</td>
      <td class="py-1 pr-2 text-center">${stkInput('br_banfield', qB)}</td>
      <td class="py-1 pr-4 text-center font-black">${qL + qB}</td>
      <td class="py-1 text-center text-xs text-[#7d6c5c]">${resv > 0 ? resv : ''}</td>
    </tr>`;
  }).join('');
  return `<tr data-vdetail="${p.id}" class="${state.expandedVariants.has(p.id) ? '' : 'hidden'}">
    <td colspan="${nCols + 2}" class="bg-[#fffdfb] px-6 py-3 border-b border-[#fff1e6]">
      <div class="text-[11px] font-black uppercase tracking-wider text-[#7d6c5c] mb-2">Variantes${p.variant_type ? ' · ' + escapeAttr(p.variant_type) : ''}</div>
      <table class="w-auto text-sm">
        <thead><tr class="text-[10px] uppercase text-[#7d6c5c] border-b border-[#fff1e6]">
          <th class="text-left pr-4 pb-1">Valor</th><th class="text-left pr-4 pb-1">Código</th><th class="text-right pr-4 pb-1">Precio</th>
          <th class="pr-2 pb-1">Stock Lomas</th><th class="pr-2 pb-1">Stock Banfield</th><th class="pr-4 pb-1">Total</th><th class="pb-1">Reserv.</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="text-[10px] text-[#7d6c5c] mt-2">Editá el stock y salí de la celda para guardar · sincroniza a Tienda Nube.</div>
    </td>
  </tr>`;
}

// Pregunta al usuario cómo borrar un producto. Si está publicado en TN ofrece
// 3 opciones: cancelar / solo POS / POS + TN. Si no está en TN, confirm simple.
// Devuelve 'cancel' | 'local' | 'both'.
async function chooseDeleteScope(product) {
  if (!product.published_tn) {
    const ok = await confirmModal({
      title: 'Eliminar producto',
      message: `¿Eliminar "${product.name}"?`,
      danger: true,
      confirmLabel: 'Eliminar',
    });
    return ok ? 'local' : 'cancel';
  }
  // Modal de 3 opciones para productos publicados en TN.
  const safeName = String(product.name || '').replace(/</g, '&lt;');
  return openModal({
    title: 'Eliminar producto',
    bodyHTML: `
      <p class="text-[#241a0d] mb-2">¿Cómo querés eliminar <b>"${safeName}"</b>?</p>
      <p class="text-sm text-[#7d6c5c]">Está publicado en Tienda Nube. Podés borrarlo solo del POS (queda activo en tu tienda online) o también de Tienda Nube.</p>
    `,
    footerHTML: `
      <button class="ing-btn-secondary" data-act="cancel">Cancelar</button>
      <button class="ing-btn-secondary" data-act="local">Solo del POS</button>
      <button class="ing-btn-primary !bg-red-600 hover:!bg-red-700" data-act="both">Borrar también de Tienda Nube</button>
    `,
    size: 'md',
    onOpen: (el, close) => {
      el.querySelector('[data-act="cancel"]').addEventListener('click', () => close('cancel'));
      el.querySelector('[data-act="local"]').addEventListener('click', () => close('local'));
      el.querySelector('[data-act="both"]').addEventListener('click', () => close('both'));
    },
  }).then((v) => v || 'cancel');
}

const state = {
  tab: 'products',
  selected: new Set(),
  page: 0,
  filters: { search: '', category: '', brand: '', supplier: '', onlyMeli: false, variant: '', stock: 'all' },
  sort: 'newest', // newest | oldest | name — por defecto los más nuevos primero
  expandedVariants: new Set(), // productos con el detalle de variantes desplegado
  visibleCols: new Set(['code', 'name', 'category', 'brand', 'supplier', 'cost', 'price', 'margin', 'stock_lomas', 'stock_banfield', 'total', 'meli']),
  // Caché de datos: se carga una sola vez y los filtros operan sobre él
  cache: null, // { products, stocks, categories, brands, suppliers, branches, subcats }
};
const PAGE_SIZE = 100;

export async function mount(el) {
  render(el);
}

function render(el) {
  const tab = state.tab;
  el.innerHTML = `
    <div class="mb-6 flex justify-between items-center">
      <div>
        <h1 class="text-3xl font-black text-[#241a0d]">Inventario</h1>
        <p class="text-sm text-[#7d6c5c] mt-1">Productos, categorías, marcas, proveedores y transferencias</p>
      </div>
    </div>

    <div class="flex gap-2 mb-6 border-b border-[#fff1e6]">
      ${tabBtn('products',      'Productos',       'inventory_2')}
      ${tabBtn('categories',    'Categorías',      'category')}
      ${tabBtn('brands',        'Marcas',          'sell')}
      ${tabBtn('suppliers',     'Proveedores',     'local_shipping')}
      ${tabBtn('subcategories', 'Subcategorías',   'label')}
      ${tabBtn('transfers',     'Transferencias',  'swap_horiz')}
    </div>

    <div id="inv-content"></div>
  `;
  el.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => { state.tab = b.dataset.tab; state.selected.clear(); render(el); }));
  const content = el.querySelector('#inv-content');
  const renderer = {
    products: () => renderProducts(content),
    categories: () => renderCatalog(content, 'Categorías', Categories, 'categoria'),
    brands: () => renderCatalog(content, 'Marcas', Brands, 'marca'),
    suppliers: () => renderCatalog(content, 'Proveedores', Suppliers, 'proveedor'),
    subcategories: () => renderCatalog(content, 'Subcategorías', Subcategories, 'subcategoria', true),
    transfers: () => renderTransfers(content),
  };
  renderer[tab]();
}

function tabBtn(id, label, icon) {
  const active = state.tab === id;
  return `<button data-tab="${id}" class="flex items-center gap-2 px-4 py-3 font-bold text-sm border-b-2 transition-all ${active ? 'border-[#d82f1e] text-[#d82f1e]' : 'border-transparent text-[#7d6c5c] hover:text-[#d82f1e]'}">
    <span class="material-symbols-outlined text-base">${icon}</span>${label}
  </button>`;
}

// ==================== PRODUCTOS ====================

// Carga (o recarga) todos los datos del inventario desde la API y los guarda en state.cache.
// Solo se llama al montar el módulo o al presionar "Actualizar".
async function loadProductsData(container) {
  container.innerHTML = `
    <div class="ing-card p-8 text-center">
      <span class="material-symbols-outlined text-4xl text-[#d82f1e] animate-spin">autorenew</span>
      <p class="mt-3 font-bold text-[#241a0d]">Cargando inventario...</p>
    </div>`;
  try {
    const products = await P.list();
    const [categories, brands, suppliers, branches, subcats] = await Promise.all([
      Categories.list().catch(() => []),
      Brands.list().catch(() => []),
      Suppliers.list().catch(() => []),
      getAll('branches').catch(() => []),
      Subcategories.list().catch(() => []),
    ]);
    // P.list() ya devuelve la lista procesada por toFront(), donde p._stocks es la lista plana.
    const stocks = (products || []).flatMap(p => p._stocks || []);
    state.cache = {
      products: products || [],
      stocks,
      categories: categories || [],
      brands: brands || [],
      suppliers: suppliers || [],
      branches: branches || [],
      subcats: subcats || [],
    };
    return true;
  } catch (e) {
    console.error('Error cargando datos de inventario:', e);
    const isOffline = e?.status === 0;
    container.innerHTML = `
      <div class="ing-card p-6 text-center">
        <span class="material-symbols-outlined text-4xl ${isOffline ? 'text-amber-500' : 'text-red-500'}">
          ${isOffline ? 'cloud_off' : 'error'}
        </span>
        <p class="mt-2 font-bold text-[#241a0d]">${isOffline ? 'Sin conexión' : 'Error al cargar inventario'}</p>
        <p class="text-sm text-[#7d6c5c] mb-4">${isOffline ? 'El inventario necesita internet para operar.' : (e.message || 'Ocurrió un error inesperado.')}</p>
        <button id="btn-retry-load" class="ing-btn-primary text-sm inline-flex items-center gap-1">
          <span class="material-symbols-outlined text-base">refresh</span> Reintentar
        </button>
      </div>`;
    container.querySelector('#btn-retry-load')?.addEventListener('click', () => renderProducts(container, true));
    return false;
  }
}

async function renderProducts(container, forceReload = false) {
  // Si no hay caché o se pide recarga, cargar desde la API
  if (!state.cache || forceReload) {
    const ok = await loadProductsData(container);
    if (!ok) return;
  }

  const { products, stocks, categories, brands, suppliers, branches } = state.cache;

  // Maps y helpers derivados del caché (O(n) lookup → O(1) map)
  const catMap = Object.fromEntries((categories || []).map(c => [c.id, c.name]));
  const brMap  = Object.fromEntries((brands || []).map(b => [b.id, b.name]));
  const spMap  = Object.fromEntries((suppliers || []).map(s => [s.id, s.name]));
  // Índice O(1) de stock por producto+sucursal (antes era un .find lineal sobre
  // ~30k stocks llamado por cada producto×sucursal → O(n²) que congelaba el render
  // con muchos productos).
  const _stockMap = new Map();
  for (const s of (stocks || [])) _stockMap.set(`${s.product_id}|${s.branch_id}`, s);
  const stockOf = (pid, bid) => _stockMap.get(`${pid}|${bid}`) || { qty: 0, reserved_qty: 0 };
  const lomas = (branches || []).find(b => b.id === 'br_lomas');
  const banf  = (branches || []).find(b => b.id === 'br_banfield');

  const f = state.filters;
  let list = products.filter(p => {
    if (f.search) {
      const q = f.search.toLowerCase();
      if (!(p.name?.toLowerCase().includes(q) || p.code?.toLowerCase().includes(q))) return false;
    }
    if (f.category && p.category_id !== f.category) return false;
    if (f.brand && p.brand_id !== f.brand) return false;
    if (f.supplier && p.supplier_id !== f.supplier) return false;
    if (f.onlyMeli && !p.published_meli) return false;
    if (f.variant) {
      const vq = f.variant.toLowerCase();
      const hit = (p.variants || []).some(v =>
        (v.name || '').toLowerCase().includes(vq) ||
        Object.entries(v.attributes || {}).some(([k, val]) => `${k} ${val}`.toLowerCase().includes(vq)));
      if (!hit) return false;
    }
    if (f.stock && f.stock !== 'all') {
      const total = stockOf(p.id, 'br_lomas').qty + stockOf(p.id, 'br_banfield').qty;
      if (f.stock === 'with' && total <= 0) return false;   // solo con stock
      if (f.stock === 'zero' && total > 0) return false;      // solo sin stock (0 o negativo)
    }
    return true;
  });

  // Orden. Por defecto los más nuevos primero (created_at desc). Fallback estable por nombre.
  const cmpName = (a, b) => (a.name || '').localeCompare(b.name || '', 'es', { sensitivity: 'base' });
  const cmpDate = (a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''));
  if (state.sort === 'oldest') list.sort((a, b) => -cmpDate(a, b) || cmpName(a, b));
  else if (state.sort === 'name') list.sort(cmpName);
  else list.sort((a, b) => cmpDate(a, b) || cmpName(a, b)); // newest (default)

  // Paginado: dibujar 15k filas de una vez es muy lento. Mostramos de a PAGE_SIZE
  // y el buscador/filtros operan sobre TODA la lista.
  const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  if (!Number.isInteger(state.page) || state.page < 0 || state.page >= totalPages) state.page = 0;
  const pageStart = state.page * PAGE_SIZE;
  const pageRows = list.slice(pageStart, pageStart + PAGE_SIZE);

  const cols = [
    { id: 'code', label: 'Código', render: p => `<span class="font-mono text-xs text-[#7d6c5c]">${p.code}</span>` },
    { id: 'name', label: 'Nombre', render: p => `<span class="font-bold">${p.name}</span>${p.has_variants ? `<span class="ml-2 px-1.5 py-0.5 rounded-full bg-[#fff1e6] text-[#d82f1e] text-[10px] font-black align-middle">${(p.variants||[]).length} ${p.variant_type || 'var'}</span>` : ''}`, editable: 'text' },
    { id: 'category', label: 'Categoría', render: p => catMap[p.category_id] || '-' },
    { id: 'brand', label: 'Marca', render: p => brMap[p.brand_id] || '-' },
    { id: 'supplier', label: 'Proveedor', render: p => spMap[p.supplier_id] || '-' },
    { id: 'cost', label: 'Costo', render: p => money(p.cost), align: 'right', editable: 'number', field: 'cost' },
    { id: 'margin', label: '% Margen', render: p => (p.cost > 0 ? `${marginOf(p).toFixed(1)}%` : '—'), align: 'right', editable: 'number', field: 'margin_pct' },
    { id: 'price', label: 'Precio', render: p => `<span class="font-bold">${money(p.price)}</span>`, align: 'right', editable: 'number', field: 'price' },
    { id: 'stock_lomas', label: `Stock ${lomas?.name || 'Lomas'}`, render: p => stockCell(stockOf(p.id, 'br_lomas')), align: 'center' },
    { id: 'stock_banfield', label: `Stock ${banf?.name || 'Banfield'}`, render: p => stockCell(stockOf(p.id, 'br_banfield')), align: 'center' },
    { id: 'total', label: 'Total', render: p => (stockOf(p.id,'br_lomas').qty + stockOf(p.id,'br_banfield').qty), align: 'center' },
    { id: 'meli', label: 'MELI', render: p => p.published_meli ? '<span class="material-symbols-outlined text-[#d82f1e] text-base">check_circle</span>' : '-', align: 'center' },
  ];
  const visibleCols = cols.filter(c => state.visibleCols.has(c.id));

  // U-6: KPIs cross-sucursal sobre la lista filtrada.
  const sumLomas = list.reduce((s, p) => s + (stockOf(p.id, 'br_lomas').qty || 0), 0);
  const sumBanf  = list.reduce((s, p) => s + (stockOf(p.id, 'br_banfield').qty || 0), 0);
  const lowStock = list.filter(p => (stockOf(p.id, 'br_lomas').qty + stockOf(p.id, 'br_banfield').qty) <= 2).length;
  const outStockBoth = list.filter(p => stockOf(p.id, 'br_lomas').qty === 0 && stockOf(p.id, 'br_banfield').qty === 0).length;

  // Barra de paginación reutilizable (se muestra arriba y abajo de la tabla).
  const pagBar = (pos) => `
    <div class="flex items-center justify-between mt-3 flex-wrap gap-2">
      <p class="text-xs text-[#7d6c5c]">${list.length} producto(s)${list.length > PAGE_SIZE ? ` · mostrando ${pageStart+1}-${Math.min(pageStart+PAGE_SIZE, list.length)}` : ''}${pos==='bottom' ? ' · doble-click para editar (Nombre, Costo, %Margen, Precio)' : ''}</p>
      ${totalPages > 1 ? `
      <div class="flex items-center gap-2">
        <button class="pg-first ing-btn-secondary text-xs !py-1.5 !px-3" ${state.page===0?'disabled':''} title="Primera">«</button>
        <button class="pg-prev ing-btn-secondary text-xs !py-1.5 !px-3" ${state.page===0?'disabled':''}>‹ Anterior</button>
        <span class="text-xs font-bold text-[#7d6c5c]">Página
          <input class="pg-input ing-input !w-14 !py-1 text-center inline-block" type="number" min="1" max="${totalPages}" value="${state.page+1}" /> de ${totalPages}</span>
        <button class="pg-next ing-btn-secondary text-xs !py-1.5 !px-3" ${state.page>=totalPages-1?'disabled':''}>Siguiente ›</button>
        <button class="pg-last ing-btn-secondary text-xs !py-1.5 !px-3" ${state.page>=totalPages-1?'disabled':''} title="Última">»</button>
      </div>` : ''}
    </div>`;

  container.innerHTML = `
    <!-- U-6: banner de consolidado cross-sucursal -->
    <div class="grid grid-cols-4 gap-3 mb-4">
      <div class="ing-card p-4"><div class="text-[10px] font-black uppercase text-[#7d6c5c]">Productos visibles</div><div class="text-2xl font-black text-[#241a0d]">${list.length}</div></div>
      <div class="ing-card p-4"><div class="text-[10px] font-black uppercase text-[#7d6c5c]">Stock ${lomas?.name || 'Lomas'}</div><div class="text-2xl font-black text-[#d82f1e]">${sumLomas}</div></div>
      <div class="ing-card p-4"><div class="text-[10px] font-black uppercase text-[#7d6c5c]">Stock ${banf?.name || 'Banfield'}</div><div class="text-2xl font-black text-[#d82f1e]">${sumBanf}</div></div>
      <div class="ing-card p-4"><div class="text-[10px] font-black uppercase text-[#7d6c5c]">Bajo / sin stock</div><div class="text-2xl font-black text-orange-600">${lowStock} <span class="text-sm font-bold text-red-600">· ${outStockBoth} en 0</span></div></div>
    </div>

    <!-- Toolbar -->
    <div class="ing-card mb-4">
      <div class="flex flex-wrap gap-3 items-center">
        <div class="relative flex-1 min-w-[240px]">
          <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[#d82f1e]">search</span>
          <input id="f-search" class="ing-input pl-10" placeholder="Buscar por nombre o código..." value="${f.search}" />
        </div>
        <div class="combo-wrap relative w-[180px]" data-combo="category">
          <input id="f-category" class="ing-input w-full" autocomplete="off" placeholder="Todas las categorías" />
          <div class="combo-menu hidden absolute z-30 mt-1 w-full max-h-64 overflow-auto bg-white border border-[#e3ceba] rounded-xl shadow-lg text-sm"></div>
        </div>
        <div class="combo-wrap relative w-[170px]" data-combo="brand">
          <input id="f-brand" class="ing-input w-full" autocomplete="off" placeholder="Todas las marcas" />
          <div class="combo-menu hidden absolute z-30 mt-1 w-full max-h-64 overflow-auto bg-white border border-[#e3ceba] rounded-xl shadow-lg text-sm"></div>
        </div>
        <div class="combo-wrap relative w-[180px]" data-combo="supplier">
          <input id="f-supplier" class="ing-input w-full" autocomplete="off" placeholder="Todos los proveedores" />
          <div class="combo-menu hidden absolute z-30 mt-1 w-full max-h-64 overflow-auto bg-white border border-[#e3ceba] rounded-xl shadow-lg text-sm"></div>
        </div>
        <input id="f-variant" class="ing-input max-w-[160px]" placeholder="Variante (talle…)" value="${escapeAttr(f.variant || '')}" />
        <select id="f-stock" class="ing-filter" title="Filtrar por stock">
          <option value="all" ${f.stock==='all'?'selected':''}>Todo el stock</option>
          <option value="with" ${f.stock==='with'?'selected':''}>Con stock</option>
          <option value="zero" ${f.stock==='zero'?'selected':''}>Sin stock (0)</option>
        </select>
        <select id="f-sort" class="ing-filter" title="Ordenar">
          <option value="newest" ${state.sort==='newest'?'selected':''}>Más nuevos</option>
          <option value="oldest" ${state.sort==='oldest'?'selected':''}>Más viejos</option>
          <option value="name" ${state.sort==='name'?'selected':''}>Nombre A-Z</option>
        </select>
        <label class="flex items-center gap-2 text-sm font-bold cursor-pointer">
          <input id="f-meli" type="checkbox" ${f.onlyMeli?'checked':''} class="rounded text-[#d82f1e] focus:ring-[#d82f1e]" /> Sólo MELI
        </label>
        <button id="f-clear" class="text-xs text-[#d82f1e] font-bold hover:underline">Limpiar</button>
        <div class="flex-1"></div>
        <button id="btn-cols" class="ing-btn-secondary text-sm">
          <span class="material-symbols-outlined align-middle text-base">view_column</span> Columnas
        </button>
        <button id="btn-export" class="ing-btn-secondary text-sm">
          <span class="material-symbols-outlined align-middle text-base">download</span> XLSX
        </button>
        <button id="btn-refresh" class="ing-btn-secondary text-sm" title="Actualizar datos desde el servidor">
          <span class="material-symbols-outlined align-middle text-base">sync</span>
        </button>
        <button id="btn-new" class="ing-btn-primary text-sm">
          <span class="material-symbols-outlined align-middle text-base">add</span> Nuevo
        </button>
      </div>

      <!-- Bulk actions bar -->
      <div id="bulk-bar" class="hidden mt-4 p-3 bg-[#fff1e6] rounded-2xl flex items-center gap-3 border border-[#e3ceba]">
        <span id="bulk-count" class="text-sm font-black text-[#d82f1e]"></span>
        <button id="bulk-edit" class="text-xs ing-btn-primary !py-1.5 !px-3"><span class="material-symbols-outlined align-middle text-sm">edit_note</span> Editar campos</button>
        <button id="bulk-meli-on" class="text-xs ing-btn-secondary !py-1.5 !px-3">Publicar en MELI</button>
        <button id="bulk-meli-off" class="text-xs ing-btn-secondary !py-1.5 !px-3">Despublicar MELI</button>
        <button id="bulk-price-pct" class="text-xs ing-btn-secondary !py-1.5 !px-3">Ajuste % precio</button>
        <button id="bulk-delete" class="text-xs px-3 py-1.5 rounded-full bg-red-50 text-red-600 font-bold hover:bg-red-100">Eliminar</button>
        <button id="bulk-clear" class="text-xs text-[#7d6c5c] hover:underline ml-auto">Deseleccionar</button>
      </div>
    </div>

    ${pagBar('top')}
    <div class="ing-card overflow-auto">
      <table class="ing-table w-full text-sm">
        <thead>
          <tr>
            <th class="w-8"><input type="checkbox" id="check-all" class="rounded text-[#d82f1e] focus:ring-[#d82f1e]" /></th>
            ${visibleCols.map(c => `<th class="${c.align==='right'?'text-right':c.align==='center'?'text-center':''}">${c.label}</th>`).join('')}
            <th class="w-8"></th>
          </tr>
        </thead>
        <tbody>
          ${list.length === 0 ? `<tr><td colspan="${visibleCols.length+2}" class="text-center py-8 text-[#7d6c5c]">Sin productos que coincidan</td></tr>` :
            pageRows.map(p => `
            <tr data-id="${p.id}" class="group">
              <td class="whitespace-nowrap"><input type="checkbox" class="row-check rounded text-[#d82f1e] focus:ring-[#d82f1e]" ${state.selected.has(p.id)?'checked':''} />${p.has_variants ? `<button data-vexp="${p.id}" title="Ver variantes" class="ml-1 align-middle"><span class="material-symbols-outlined text-base text-[#7d6c5c] hover:text-[#d82f1e] transition-transform ${state.expandedVariants.has(p.id)?'rotate-90':''}" data-vchev="${p.id}">chevron_right</span></button>` : ''}</td>
              ${visibleCols.map(c => `<td class="${c.align==='right'?'text-right':c.align==='center'?'text-center':''}" ${c.editable?`data-editable="${c.editable}" data-field="${c.field||c.id}"`:''}>${c.render(p)}</td>`).join('')}
              <td class="text-right">
                <button data-tnlink="${p.id}" title="${p.linked_tn ? 'Vinculado a Tienda Nube (click para desvincular)' : 'Vincular con Tienda Nube'}" class="${p.linked_tn ? '' : 'opacity-0 group-hover:opacity-100'} p-1.5 hover:bg-[#fff1e6] rounded-full transition-all"><span class="material-symbols-outlined text-base ${p.linked_tn ? 'text-green-600' : 'text-[#7d6c5c]'}">${p.linked_tn ? 'link' : 'add_link'}</span></button>
                <button data-edit="${p.id}" class="opacity-0 group-hover:opacity-100 p-1.5 hover:bg-[#fff1e6] rounded-full transition-all"><span class="material-symbols-outlined text-base text-[#7d6c5c]">edit</span></button>
                <button data-del="${p.id}"  class="opacity-0 group-hover:opacity-100 p-1.5 hover:bg-red-50 rounded-full transition-all"><span class="material-symbols-outlined text-base text-red-500">delete</span></button>
              </td>
            </tr>
            ${p.has_variants ? variantDetailRow(p, visibleCols.length) : ''}
          `).join('')}
        </tbody>
      </table>
    </div>
    ${pagBar('bottom')}
  `;
  const goPage = (n) => { const t = Math.max(1, Math.ceil(list.length / PAGE_SIZE)); state.page = Math.min(Math.max(0, n), t - 1); renderProducts(container); };
  container.querySelectorAll('.pg-first').forEach(b => b.addEventListener('click', () => goPage(0)));
  container.querySelectorAll('.pg-prev').forEach(b => b.addEventListener('click', () => goPage(state.page - 1)));
  container.querySelectorAll('.pg-next').forEach(b => b.addEventListener('click', () => goPage(state.page + 1)));
  container.querySelectorAll('.pg-last').forEach(b => b.addEventListener('click', () => goPage(totalPages - 1)));
  container.querySelectorAll('.pg-input').forEach(inp => inp.addEventListener('change', (e) => { const n = parseInt(e.target.value, 10); if (Number.isFinite(n)) goPage(n - 1); }));

  // Filtros
  container.querySelector('#f-search').addEventListener('input', e => { state.filters.search = e.target.value; state.page = 0; scheduleFilterRender(container, 'f-search'); });
  // Comboboxes filtrables (escribir/autocompletar/desplegar) + crear al vuelo. Alfabéticos.
  mountCombo(container.querySelector('[data-combo="category"]'), {
    options: categories, selectedId: f.category, allLabel: 'Todas las categorías',
    onPick: (id) => { state.filters.category = id; state.page = 0; renderProducts(container); },
    onCreate: async (name) => { const c = await Categories.save({ name }); if (state.cache) state.cache.categories = [...(state.cache.categories||[]), c]; toast(`Categoría "${name}" creada`, 'success'); return c; },
  });
  mountCombo(container.querySelector('[data-combo="brand"]'), {
    options: brands, selectedId: f.brand, allLabel: 'Todas las marcas',
    onPick: (id) => { state.filters.brand = id; state.page = 0; renderProducts(container); },
    onCreate: async (name) => { const b = await Brands.save({ name }); if (state.cache) state.cache.brands = [...(state.cache.brands||[]), b]; toast(`Marca "${name}" creada`, 'success'); return b; },
  });
  mountCombo(container.querySelector('[data-combo="supplier"]'), {
    options: suppliers, selectedId: f.supplier, allLabel: 'Todos los proveedores',
    onPick: (id) => { state.filters.supplier = id; state.page = 0; renderProducts(container); },
    onCreate: async (name) => { const s = await Suppliers.save({ name }); if (state.cache) state.cache.suppliers = [...(state.cache.suppliers||[]), s]; toast(`Proveedor "${name}" creado`, 'success'); return s; },
  });
  container.querySelector('#f-meli').addEventListener('change', e => { state.filters.onlyMeli = e.target.checked; state.page = 0; renderProducts(container); });
  container.querySelector('#f-variant').addEventListener('input', e => { state.filters.variant = e.target.value; state.page = 0; scheduleFilterRender(container, 'f-variant'); });
  container.querySelector('#f-stock').addEventListener('change', e => { state.filters.stock = e.target.value; state.page = 0; renderProducts(container); });
  container.querySelector('#f-sort').addEventListener('change', e => { state.sort = e.target.value; state.page = 0; renderProducts(container); });
  container.querySelector('#f-clear').addEventListener('click', () => { state.filters = { search:'', category:'', brand:'', supplier:'', onlyMeli:false, variant:'', stock:'all' }; state.page = 0; renderProducts(container); });

  container.querySelector('#btn-new').addEventListener('click', () => openProductForm(null, container));
  container.querySelector('#btn-cols').addEventListener('click', () => openColumnsModal(cols, container));
  container.querySelector('#btn-refresh').addEventListener('click', async () => {
    state.cache = null; // Invalida caché para forzar recarga desde el servidor
    await renderProducts(container);
  });
  container.querySelector('#btn-export').addEventListener('click', () => {
    const rows = list.map(p => ({
      Codigo: p.code, Nombre: p.name,
      Categoria: catMap[p.category_id] || '',
      Marca: brMap[p.brand_id] || '',
      Proveedor: spMap[p.supplier_id] || '',
      Costo: p.cost, Margen_pct: p.margin_pct, Precio: p.price,
      Stock_Lomas: stockOf(p.id,'br_lomas').qty,
      Reservado_Lomas: stockOf(p.id,'br_lomas').reserved_qty,
      Stock_Banfield: stockOf(p.id,'br_banfield').qty,
      Reservado_Banfield: stockOf(p.id,'br_banfield').reserved_qty,
      MELI: p.published_meli ? 'Sí' : 'No',
    }));
    exportSimple(`productos_${new Date().toISOString().slice(0,10)}.xlsx`, rows, 'Productos');
    toast('XLSX generado', 'success');
  });

  // Selección
  container.querySelectorAll('.row-check').forEach(chk => {
    chk.addEventListener('change', e => {
      const id = e.target.closest('tr').dataset.id;
      if (e.target.checked) state.selected.add(id); else state.selected.delete(id);
      updateBulkBar(container);
    });
  });
  container.querySelector('#check-all').addEventListener('change', e => {
    state.selected = new Set(e.target.checked ? list.map(p => p.id) : []);
    renderProducts(container);
  });
  updateBulkBar(container);

  // Acciones individuales
  container.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', async () => {
    const p = list.find(x => x.id === b.dataset.edit);
    openProductForm(p, container);
  }));
  // Desplegar/plegar el detalle de variantes (chevron)
  container.querySelectorAll('[data-vexp]').forEach(b => b.addEventListener('click', () => {
    const pid = b.dataset.vexp;
    const open = state.expandedVariants.has(pid) ? (state.expandedVariants.delete(pid), false) : (state.expandedVariants.add(pid), true);
    const dr = container.querySelector(`[data-vdetail="${CSS.escape(pid)}"]`);
    const ch = container.querySelector(`[data-vchev="${CSS.escape(pid)}"]`);
    if (dr) dr.classList.toggle('hidden', !open);
    if (ch) ch.classList.toggle('rotate-90', open);
  }));
  // Edición inline del stock de cada variante por sucursal (sincroniza a Tienda Nube)
  container.querySelectorAll('[data-vstock]').forEach(inp => inp.addEventListener('change', async () => {
    const variantId = inp.dataset.vstock, branchId = inp.dataset.vbranch, pid = inp.dataset.pid;
    const qty = Math.max(0, Math.trunc(Number(inp.value) || 0));
    if (inp.dataset.saving === '1') return;
    inp.dataset.saving = '1';
    inp.disabled = true;
    try {
      await P.setStock(pid, branchId, { variantId, qty, reason: 'Ajuste de variante (inventario)' });
      inp.value = qty; // normaliza lo mostrado
      // Actualizamos el cache en memoria y SOLO la celda "Total" de esta variante,
      // SIN re-renderizar toda la tabla: así una edición no pisa la otra celda
      // (Lomas/Banfield) que el operador puede estar editando en la misma fila.
      const p = state.cache.products.find(x => x.id === pid);
      if (p) {
        const v = (p.variants || []).find(x => x.id === variantId);
        if (v) {
          v.stocks = v.stocks || {};
          v.stocks[branchId] = { qty, reserved: v.stocks[branchId]?.reserved || 0 };
          const row = inp.closest('tr');
          const totalCell = row?.querySelector('td:nth-last-child(2)');
          const qL = v.stocks?.br_lomas?.qty ?? 0, qB = v.stocks?.br_banfield?.qty ?? 0;
          if (totalCell) totalCell.textContent = String(qL + qB);
        }
        recomputeProductStocks(p);
        state.cache.stocks = state.cache.products.flatMap(x => x._stocks || []);
      }
      // Señal visual breve (sin re-render).
      inp.style.borderColor = '#16a34a';
      setTimeout(() => { inp.style.borderColor = ''; }, 900);
      toast('Stock actualizado', 'success');
    } catch (e) {
      toast('No se pudo actualizar el stock: ' + (e.message || ''), 'error');
      // Revertir al valor guardado en cache para no dejar un número que no se aplicó.
      const v = state.cache.products.find(x => x.id === pid)?.variants?.find(x => x.id === variantId);
      if (v) inp.value = v.stocks?.[branchId]?.qty ?? 0;
    } finally {
      // SIEMPRE re-habilitar: nunca más queda "tildado"/trabado.
      inp.disabled = false;
      inp.dataset.saving = '';
    }
  }));
  container.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    const p = list.find(x => x.id === b.dataset.del);
    if (!p) return;
    const choice = await chooseDeleteScope(p);
    if (choice === 'cancel') return;
    try {
      // 'local' = solo del POS (queda en TN) · 'both' = también de Tienda Nube.
      await P.remove(p.id, { keepTn: choice === 'local' });
      // Quitar del caché en memoria (optimistic remove) para que renderProducts sea instantáneo
      if (state.cache) state.cache.products = state.cache.products.filter(x => x.id !== p.id);
      toast(choice === 'both' ? 'Eliminado del POS y Tienda Nube' : 'Eliminado del POS', 'success');
      renderProducts(container);
    } catch (e) {
      console.warn('delete falló', e);
      toast('No se pudo eliminar', 'error');
    }
  }));

  // Vincular / desvincular con Tienda Nube
  container.querySelectorAll('[data-tnlink]').forEach(b => b.addEventListener('click', async () => {
    const p = list.find(x => x.id === b.dataset.tnlink);
    if (!p) return;
    if (p.linked_tn) {
      const ok = await confirmModal({ title: 'Desvincular de Tienda Nube', message: `¿Desvincular "${p.name}" de Tienda Nube? (deja de sincronizar stock)`, danger: true, confirmLabel: 'Desvincular' });
      if (!ok) return;
      try { await P.unlinkTn(p.id); toast('Desvinculado de Tienda Nube', 'success'); renderProducts(container); }
      catch (e) { toast('No se pudo desvincular', 'error'); }
    } else {
      openTnLinkModal(p, container);
    }
  }));

  // Edición inline
  container.querySelectorAll('[data-editable]').forEach(td => {
    td.addEventListener('dblclick', () => editInline(td, list, container));
  });

  // Bulk buttons
  const bulkBar = container.querySelector('#bulk-bar');
  bulkBar.querySelector('#bulk-clear').addEventListener('click', () => { state.selected.clear(); renderProducts(container); });
  bulkBar.querySelector('#bulk-edit').addEventListener('click', () => bulkEditFields(container));
  bulkBar.querySelector('#bulk-meli-on').addEventListener('click', () => bulkSetMeli(true, container));
  bulkBar.querySelector('#bulk-meli-off').addEventListener('click', () => bulkSetMeli(false, container));
  bulkBar.querySelector('#bulk-price-pct').addEventListener('click', () => bulkPricePct(container));
  bulkBar.querySelector('#bulk-delete').addEventListener('click', () => bulkDelete(container));
}

function stockCell(s) {
  if (s.reserved_qty) return `${s.qty} <span class="text-[10px] text-[#d82f1e]">(${s.reserved_qty} res.)</span>`;
  return String(s.qty);
}

function updateBulkBar(container) {
  const bar = container.querySelector('#bulk-bar');
  if (!bar) return;
  if (state.selected.size === 0) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  bar.querySelector('#bulk-count').textContent = `${state.selected.size} seleccionado(s)`;
}

async function editInline(td, list, container) {
  const tr = td.closest('tr');
  const id = tr.dataset.id;
  const p = list.find(x => x.id === id);
  if (!p) return;
  const field = td.dataset.field;
  const type = td.dataset.editable;
  // El margen se edita a partir del valor REAL (derivado de costo y precio),
  // no del guardado (que puede estar desactualizado).
  const current = field === 'margin_pct' ? +marginOf(p).toFixed(2) : (p[field] ?? '');
  const input = document.createElement('input');
  // Números: type=text + inputmode decimal para aceptar formato argentino
  // (1.234,56). Un <input type=number> descarta esos valores y guardaba 0.
  input.type = 'text';
  if (type === 'number') input.inputMode = 'decimal';
  input.value = current;
  input.className = 'w-full p-1 border-2 border-[#d82f1e] rounded bg-white text-sm font-bold';
  td.innerHTML = '';
  td.appendChild(input);
  input.focus(); input.select();
  const save = async () => {
    let v;
    if (type === 'number') {
      v = parseNumAR(input.value);
      if (v === null) { toast('Número inválido — no se guardó', 'warn'); renderProducts(container); return; }
    } else {
      v = input.value;
    }
    // Vínculo costo ↔ margen ↔ precio:
    // - Editar COSTO: mantiene el margen actual y recalcula el precio (redondeado a $10).
    // - Editar MARGEN %: recalcula el precio (redondeado a $10), costo intacto.
    // - Editar PRECIO: se toma tal cual (editable libre) y recalcula el margen.
    if (field === 'cost') {
      const ratio = p.cost > 0 ? (p.price / p.cost - 1) : 0; // margen actual como fracción
      p.cost = v;
      p.price = roundPrice(v * (1 + ratio));
    } else if (field === 'margin_pct') {
      p.price = roundPrice(p.cost * (1 + v / 100));
    } else if (field === 'price') {
      p.price = v;
    } else {
      p[field] = v;
    }
    // Guardar el margen coherente con costo/precio finales.
    p.margin_pct = +marginOf(p).toFixed(2);
    await P.save(p);
    // Actualizar el objeto en el caché (optimistic update) para que renderProducts no vaya a la red
    if (state.cache) {
      const idx = state.cache.products.findIndex(x => x.id === p.id);
      if (idx !== -1) state.cache.products[idx] = { ...state.cache.products[idx], ...p };
    }
    toast('Actualizado', 'success');
    renderProducts(container);
  };
  input.addEventListener('blur', save);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { input.blur(); }
    if (e.key === 'Escape') { renderProducts(container); }
  });
}

async function openProductForm(p, container) {
  const [cats, brs, sps, subs, branches] = await Promise.all([
    Categories.list(), Brands.list(), Suppliers.list(), Subcategories.list(), getAll('branches'),
  ]);
  const lomas = branches.find(b => b.id === 'br_lomas');
  const banf  = branches.find(b => b.id === 'br_banfield');
  const stockLomas = p ? (await P.getStock(p.id, 'br_lomas')).qty : 0;
  const stockBanf  = p ? (await P.getStock(p.id, 'br_banfield')).qty : 0;
  const isEdit = !!p;
  const body = `
    ${isEdit ? '' : `
    <div class="flex items-center justify-between gap-4 mb-3 flex-wrap">
      <div class="flex gap-1 p-1 bg-[#fff1e6] rounded-2xl w-fit" id="mode-toggle">
        <button type="button" data-mode="single" class="mode-btn px-4 py-2 text-sm font-bold rounded-xl bg-white text-[#d82f1e] shadow-sm">Un producto</button>
        <button type="button" data-mode="batch"  class="mode-btn px-4 py-2 text-sm font-bold rounded-xl text-[#7d6c5c]">Varios (lote)</button>
      </div>
      <div id="keep-fields-wrapper" class="hidden flex-col gap-1">
        <label id="keep-fields-label" class="flex items-center gap-2 cursor-pointer text-sm font-bold text-[#241a0d] bg-[#fff8f0] border border-[#e3ceba] rounded-2xl px-3 py-2">
          <input type="checkbox" id="keep-fields" checked class="rounded text-[#d82f1e] focus:ring-[#d82f1e]" />
          <span>Mantener Categoría / Marca / Proveedor / Subcategoría</span>
        </label>
        <label id="keep-tn-cats-label" class="flex items-center gap-2 cursor-pointer text-sm font-bold text-[#241a0d] bg-[#fff8f0] border border-[#e3ceba] rounded-2xl px-3 py-2">
          <input type="checkbox" id="keep-tn-cats" checked class="rounded text-[#d82f1e] focus:ring-[#d82f1e]" />
          <img src="assets/img/tiendanube.png" alt="" class="h-4 w-4 object-contain" />
          <span>Mantener categorías de Tienda Nube</span>
        </label>
      </div>
    </div>`}
    <form id="prod-form" class="grid grid-cols-3 gap-3">
      <label class="col-span-3"><span class="text-xs font-black text-[#7d6c5c] uppercase">Nombre *</span>
        <input name="name" class="ing-input mt-1" required value="${p?.name || ''}" />
      </label>
      <label><span class="text-xs font-black text-[#7d6c5c] uppercase">Costo *</span>
        <input name="cost" type="text" inputmode="decimal" class="ing-input mt-1" required value="${p?.cost || 0}" />
      </label>
      <label><span class="text-xs font-black text-[#7d6c5c] uppercase">% Margen</span>
        <input name="margin_pct" type="text" inputmode="decimal" class="ing-input mt-1" value="${p && p.cost > 0 ? marginOf(p).toFixed(2) : (p?.margin_pct || 0)}" />
      </label>
      <label><span class="text-xs font-black text-[#7d6c5c] uppercase">Precio</span>
        <input name="price" type="text" inputmode="decimal" class="ing-input mt-1" value="${p?.price || 0}" />
      </label>
      <label><span class="text-xs font-black text-[#7d6c5c] uppercase">Categoría</span>
        <select name="category_id" class="ing-input mt-1">
          <option value="">--</option>
          ${cats.map(c => `<option value="${c.id}" ${p?.category_id===c.id?'selected':''}>${c.name}</option>`).join('')}
        </select>
      </label>
      <label><span class="text-xs font-black text-[#7d6c5c] uppercase">Marca</span>
        <select name="brand_id" class="ing-input mt-1">
          <option value="">--</option>
          ${brs.map(b => `<option value="${b.id}" ${p?.brand_id===b.id?'selected':''}>${b.name}</option>`).join('')}
        </select>
      </label>
      <label><span class="text-xs font-black text-[#7d6c5c] uppercase">Proveedor</span>
        <select name="supplier_id" class="ing-input mt-1">
          <option value="">--</option>
          ${sps.map(s => `<option value="${s.id}" ${p?.supplier_id===s.id?'selected':''}>${s.name}</option>`).join('')}
        </select>
      </label>
      <label><span class="text-xs font-black text-[#7d6c5c] uppercase">Subcategoría</span>
        <select name="subcategory_id" class="ing-input mt-1">
          <option value="">--</option>
          ${subs.map(s => `<option value="${s.id}" ${p?.subcategory_id===s.id?'selected':''}>${s.name}</option>`).join('')}
        </select>
      </label>
      <label class="col-span-2"><span class="text-xs font-black text-[#7d6c5c] uppercase">Código</span>
        <input name="code" class="ing-input mt-1" value="${p?.code || ''}" />
      </label>
      <div id="single-stock-block" class="col-span-3 grid grid-cols-2 gap-3 p-2 bg-[#fff1e6] rounded-xl border border-[#e3ceba]">
        <label><span class="text-xs font-black text-[#7d6c5c] uppercase">Stock ${lomas?.name || 'Lomas'}</span>
          <input name="stock_lomas" type="number" min="0" step="1" class="ing-input mt-1" value="${stockLomas}" />
        </label>
        <label><span class="text-xs font-black text-[#7d6c5c] uppercase">Stock ${banf?.name || 'Banfield'}</span>
          <input name="stock_banfield" type="number" min="0" step="1" class="ing-input mt-1" value="${stockBanf}" />
        </label>
      </div>

      <!-- Variantes -->
      <div class="col-span-3">
        <label class="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" id="chk-has-variants" ${p?.has_variants ? 'checked' : ''} class="rounded text-[#d82f1e] focus:ring-[#d82f1e]" />
          <span class="text-sm font-bold">Este producto tiene variantes (talles / colores)</span>
        </label>
        <div id="variant-editor" class="${p?.has_variants ? '' : 'hidden'} mt-2 p-3 rounded-2xl bg-[#fff8f0] border border-[#e3ceba] space-y-2">
          <label class="block max-w-xs"><span class="text-xs font-black text-[#7d6c5c] uppercase">Tipo de variante</span>
            <input id="variant-type" list="variant-types-dl" class="ing-input mt-1" placeholder="Talle, Color…" value="${escapeAttr(p?.variant_type || '')}" />
            <datalist id="variant-types-dl"></datalist>
          </label>
          <datalist id="variant-values-dl"></datalist>
          <div class="grid grid-cols-[1fr_110px_140px_100px_90px_90px_32px] gap-2 px-1 text-[10px] font-black uppercase text-[#7d6c5c]">
            <div>Valor</div><div>Código</div><div>Barcode</div><div>Precio</div><div class="text-center">${lomas?.name || 'Lomas'}</div><div class="text-center">${banf?.name || 'Banfield'}</div><div></div>
          </div>
          <div id="variant-rows" class="space-y-1"></div>
          <button type="button" id="add-variant-row" class="text-sm font-bold text-[#d82f1e] hover:underline">+ Agregar valor</button>
        </div>
      </div>
      <div class="col-span-3 flex gap-6 items-center">
        <label class="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" name="published_meli" ${p?.published_meli ? 'checked' : ''} class="rounded text-[#d82f1e] focus:ring-[#d82f1e]" />
          <span class="text-sm font-bold">Publicar en MercadoLibre</span>
        </label>
        <label class="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" name="published_tn" id="chk-published-tn" ${p?.published_tn ? 'checked' : ''} class="rounded text-[#d82f1e] focus:ring-[#d82f1e]" />
          <span class="text-sm font-bold">Publicar en Tienda Nube</span>
          <img src="assets/img/tiendanube.png" alt="Tienda Nube" class="h-6 w-6 object-contain" />
        </label>
      </div>

      <!-- Sección Tienda Nube: se muestra al tildar "Publicar en Tienda Nube" -->
      <div id="tn-section" class="${p?.published_tn ? '' : 'hidden'} col-span-3 mt-2 p-4 rounded-2xl bg-[#fff8f0] border border-[#e3ceba] space-y-3">
        <div class="flex items-center gap-2 mb-1">
          <img src="assets/img/tiendanube.png" alt="" class="h-5 w-5 object-contain" />
          <h4 class="font-black text-[#241a0d]">Datos para Tienda Nube</h4>
        </div>

        <label class="block">
          <span class="text-xs font-black text-[#7d6c5c] uppercase">Descripción</span>
          <textarea name="description" rows="3" class="ing-input mt-1" placeholder="Descripción del producto (acepta HTML básico)">${escapeAttr(p?.description || '')}</textarea>
        </label>

        <div class="grid grid-cols-4 gap-3">
          <label><span class="text-xs font-black text-[#7d6c5c] uppercase">Precio promo $</span>
            <input name="promotional_price" type="text" inputmode="decimal" class="ing-input mt-1" value="${p?.promotional_price ?? ''}" placeholder="opcional" />
          </label>
          <label><span class="text-xs font-black text-[#7d6c5c] uppercase">Peso (kg)</span>
            <input name="weight" type="number" step="0.001" min="0" class="ing-input mt-1" value="${p?.weight ?? ''}" placeholder="0.5" />
          </label>
          <label><span class="text-xs font-black text-[#7d6c5c] uppercase">URL slug</span>
            <input name="handle" type="text" class="ing-input mt-1" value="${escapeAttr(p?.handle || '')}" placeholder="auto desde nombre" />
          </label>
          <label><span class="text-xs font-black text-[#7d6c5c] uppercase">URL video</span>
            <input name="video_url" type="url" class="ing-input mt-1" value="${escapeAttr(p?.video_url || '')}" placeholder="youtu.be/..." />
          </label>
        </div>

        <div class="grid grid-cols-3 gap-3">
          <label><span class="text-xs font-black text-[#7d6c5c] uppercase">Ancho (cm)</span>
            <input name="width" type="number" step="0.1" min="0" class="ing-input mt-1" value="${p?.width ?? ''}" />
          </label>
          <label><span class="text-xs font-black text-[#7d6c5c] uppercase">Alto (cm)</span>
            <input name="height" type="number" step="0.1" min="0" class="ing-input mt-1" value="${p?.height ?? ''}" />
          </label>
          <label><span class="text-xs font-black text-[#7d6c5c] uppercase">Profundidad (cm)</span>
            <input name="depth" type="number" step="0.1" min="0" class="ing-input mt-1" value="${p?.depth ?? ''}" />
          </label>
        </div>

        <label class="block">
          <span class="text-xs font-black text-[#7d6c5c] uppercase">SEO Título</span>
          <input name="seo_title" type="text" class="ing-input mt-1" value="${escapeAttr(p?.seo_title || '')}" placeholder="Título para buscadores (opcional)" />
        </label>
        <label class="block">
          <span class="text-xs font-black text-[#7d6c5c] uppercase">SEO Descripción</span>
          <textarea name="seo_description" rows="2" class="ing-input mt-1" placeholder="Meta description (opcional, ~155 chars)">${escapeAttr(p?.seo_description || '')}</textarea>
        </label>

        <div>
          <span class="text-xs font-black text-[#7d6c5c] uppercase block mb-1">Categorías en Tienda Nube</span>
          <div class="border border-[#e3ceba] rounded-xl bg-white overflow-hidden">
            <div class="flex items-center gap-2 px-2 border-b border-[#e3ceba]">
              <span class="material-symbols-outlined text-base text-[#7d6c5c]">search</span>
              <input id="tn-cats-search" type="search" placeholder="Buscar categoría..." class="flex-1 py-2 text-sm bg-transparent focus:outline-none" />
            </div>
            <div id="tn-cats-box" class="max-h-48 overflow-auto p-1 text-sm">
              <div class="text-[#7d6c5c] italic p-2">Cargando categorías de Tienda Nube...</div>
            </div>
          </div>
        </div>

        <div>
          <span class="text-xs font-black text-[#7d6c5c] uppercase block mb-1">Imágenes</span>
          <div id="tn-images-thumbs" class="flex gap-2 flex-wrap mb-2"></div>
          <label class="inline-flex items-center gap-2 cursor-pointer px-3 py-2 bg-white border border-[#e3ceba] rounded-xl hover:bg-[#fff1e6]">
            <input type="file" multiple accept="image/png,image/jpeg,image/webp" id="tn-image-input" class="hidden" />
            <span class="material-symbols-outlined text-base">add_photo_alternate</span>
            <span class="text-sm font-bold">Subir imágenes</span>
          </label>
          <p class="text-xs text-[#7d6c5c] mt-1">PNG/JPG/WebP. Se publican en Tienda Nube junto al producto.</p>
        </div>
      </div>
    </form>
    ${isEdit ? '' : `
    <div id="batch-panel" class="hidden mt-4 p-3 rounded-2xl bg-[#fff8f0] border border-[#e3ceba]">
      <div class="text-xs font-black uppercase text-[#7d6c5c] mb-2">Productos en este lote (<span id="batch-count">0</span>)</div>
      <div id="batch-list" class="text-sm text-[#7d6c5c] italic">Sin productos cargados aún</div>
    </div>`}
  `;
  const footerSingle = `
    <button class="ing-btn-secondary" data-act="cancel">Cancelar</button>
    <button class="ing-btn-primary" data-act="save">${isEdit ? 'Guardar' : 'Guardar'}</button>`;
  const footerBatch = `
    <button class="ing-btn-secondary" data-act="cancel-batch">Cancelar</button>
    <button class="ing-btn-secondary" data-act="save-and-continue">Agregar y seguir</button>
    <button class="ing-btn-primary" data-act="finish-batch">Terminar lote</button>`;
  openModal({
    title: isEdit ? 'Editar producto' : 'Nuevo producto',
    bodyHTML: body,
    footerHTML: `<div id="footer-single" class="flex gap-3">${footerSingle}</div>${isEdit ? '' : `<div id="footer-batch" class="hidden gap-3">${footerBatch}</div>`}`,
    size: 'xl',
    minimizable: true,
    closeOnBackdrop: false,
    onOpen: (el, close) => {
      const form = el.querySelector('#prod-form');
      // Live recompute de precio cuando cambia costo o %
      const costIn = form.elements.cost, pctIn = form.elements.margin_pct, priceIn = form.elements.price;
      const nz = (s) => parseNumAR(s) ?? 0; // tolerante a formato AR (1.234,56)
      // Precio calculado se redondea a la decena ($10); el usuario puede editarlo igual.
      const recalcPrice = () => priceIn.value = roundPrice(nz(costIn.value) * (1 + nz(pctIn.value)/100));
      const recalcPct = () => { if (nz(costIn.value) > 0) pctIn.value = ((nz(priceIn.value)/nz(costIn.value)-1)*100).toFixed(2); };
      costIn.addEventListener('input', recalcPrice);
      pctIn.addEventListener('input', recalcPrice);
      priceIn.addEventListener('input', recalcPct);

      // ----- Editor de variantes -----
      const hasVarChk = el.querySelector('#chk-has-variants');
      const variantEditor = el.querySelector('#variant-editor');
      const singleStock = el.querySelector('#single-stock-block');
      const variantTypeIn = el.querySelector('#variant-type');
      const variantRowsEl = el.querySelector('#variant-rows');
      try {
        const sug = P.variantSuggestions();
        el.querySelector('#variant-types-dl').innerHTML = (sug.types || []).map(t => `<option value="${escapeAttr(t)}"></option>`).join('');
        el.querySelector('#variant-values-dl').innerHTML = (sug.values || []).map(v => `<option value="${escapeAttr(v)}"></option>`).join('');
      } catch { /* sin sugerencias */ }
      const variantRows = [];
      if (isEdit && p?.has_variants && p?.variants?.length) {
        for (const v of p.variants) {
          variantRows.push({
            id: v.id, valor: Object.values(v.attributes || {})[0] || v.name || '',
            code: v.code || '', barcode: v.barcode || '', price: v.price_override ?? '',
            lomas: v.stocks?.br_lomas?.qty ?? 0, banf: v.stocks?.br_banfield?.qty ?? 0,
          });
        }
      }
      const drawVariantRows = () => {
        variantRowsEl.innerHTML = variantRows.map((r, i) => `
          <div class="grid grid-cols-[1fr_110px_140px_100px_90px_90px_32px] gap-2 items-center" data-vrow="${i}">
            <input data-vk="valor" list="variant-values-dl" class="ing-input !py-1" value="${escapeAttr(r.valor)}" placeholder="M" />
            <input data-vk="code" class="ing-input !py-1" value="${escapeAttr(r.code)}" />
            <input data-vk="barcode" class="ing-input !py-1" value="${escapeAttr(r.barcode)}" />
            <input data-vk="price" type="text" inputmode="decimal" class="ing-input !py-1" value="${r.price}" placeholder="opc" />
            <input data-vk="lomas" type="number" min="0" step="1" class="ing-input !py-1 text-center" value="${r.lomas}" />
            <input data-vk="banf" type="number" min="0" step="1" class="ing-input !py-1 text-center" value="${r.banf}" />
            <button type="button" data-vrm="${i}" class="text-red-500 font-bold">✕</button>
          </div>`).join('');
        variantRowsEl.querySelectorAll('[data-vrow]').forEach((row) => {
          const i = Number(row.dataset.vrow);
          row.querySelectorAll('[data-vk]').forEach((inp) => inp.addEventListener('input', (e) => { variantRows[i][inp.dataset.vk] = e.target.value; }));
        });
        variantRowsEl.querySelectorAll('[data-vrm]').forEach((b) => b.addEventListener('click', () => { variantRows.splice(Number(b.dataset.vrm), 1); drawVariantRows(); }));
      };
      drawVariantRows();
      el.querySelector('#add-variant-row')?.addEventListener('click', () => { variantRows.push({ valor: '', code: '', barcode: '', price: '', lomas: 0, banf: 0 }); drawVariantRows(); });
      const syncVariantVisibility = () => {
        const on = !!hasVarChk?.checked;
        variantEditor?.classList.toggle('hidden', !on);
        singleStock?.classList.toggle('hidden', on);
        if (on && variantRows.length === 0) { variantRows.push({ valor: '', code: '', barcode: '', price: '', lomas: 0, banf: 0 }); drawVariantRows(); }
      };
      hasVarChk?.addEventListener('change', syncVariantVisibility);
      syncVariantVisibility();

      // Toggle de la sección TN según el checkbox "Publicar en Tienda Nube".
      const tnSection = el.querySelector('#tn-section');
      const tnChk = el.querySelector('#chk-published-tn');
      const refreshTnSection = () => {
        if (!tnSection || !tnChk) return;
        tnSection.classList.toggle('hidden', !tnChk.checked);
      };
      tnChk?.addEventListener('change', refreshTnSection);

      // Carga lazy de categorías de Tienda Nube (sólo si la sección está visible o se va a mostrar).
      let tnCategoriesLoaded = false;
      const selectedTnCats = new Set((p?.tn_category_ids || []).map(Number));
      const loadTnCategories = async () => {
        if (tnCategoriesLoaded) return;
        tnCategoriesLoaded = true;
        const box = el.querySelector('#tn-cats-box');
        if (!box) return;
        try {
          const { api } = await import('../core/api.js');
          const resp = await api('/api/tiendanube/categories');
          if (!resp?.connected) {
            box.innerHTML = '<div class="text-[#7d6c5c] italic p-2">Conectá Tienda Nube en Integraciones para listar categorías.</div>';
            return;
          }
          const list = resp.categories || [];
          if (list.length === 0) {
            box.innerHTML = '<div class="text-[#7d6c5c] italic p-2">Tu tienda no tiene categorías cargadas en Tienda Nube todavía.</div>';
            return;
          }

          // Lista plana ordenada alfabéticamente (natural, ignorando símbolos iniciales).
          // sortKey: trim + saca símbolos iniciales (+, –, *) así "+18" se ordena por "18".
          // Comparación con locale es-AR y numeric:true para que "3 a 5 años" < "12 a 17 años".
          const sortKey = (n) => String(n || '').trim().replace(/^[^\p{L}\p{N}]+/u, '').toLowerCase();
          const cmp = (a, b) => sortKey(a.name).localeCompare(sortKey(b.name), 'es', { numeric: true, sensitivity: 'base' });
          const sorted = [...list].sort(cmp);

          box.innerHTML = sorted.map((c) => {
            const nameLower = c.name.toLowerCase().replace(/"/g, '&quot;');
            return `
              <label class="cat-row flex items-center gap-2 py-0.5 px-1 cursor-pointer hover:bg-[#fff1e6] rounded" data-cat-name="${nameLower}">
                <input type="checkbox" data-tn-cat="${c.id}" ${selectedTnCats.has(c.id) ? 'checked' : ''} class="rounded text-[#d82f1e] focus:ring-[#d82f1e]" />
                <span style="padding-left:${(c.level || 0) * 14}px">${escapeAttr(c.name)}</span>
              </label>
            `;
          }).join('');

          // Buscador: filtro simple por substring sobre el nombre.
          const searchInput = el.querySelector('#tn-cats-search');
          const applyFilter = (q) => {
            const rows = box.querySelectorAll('.cat-row');
            rows.forEach((r) => {
              const name = r.dataset.catName || '';
              r.classList.toggle('hidden', q && !name.includes(q));
            });
          };
          searchInput?.addEventListener('input', () => applyFilter(searchInput.value.trim().toLowerCase()));
        } catch (e) {
          console.warn('No se pudieron cargar categorías TN', e);
          box.innerHTML = '<div class="text-red-700 italic p-2">No se pudieron cargar categorías (¿backend offline?).</div>';
        }
      };
      // Si arrancamos con TN tildado, cargamos ya. Si no, cargamos cuando se tilde por primera vez.
      if (tnChk?.checked) loadTnCategories();
      tnChk?.addEventListener('change', () => { if (tnChk.checked) loadTnCategories(); });

      // ----- Imágenes -----
      // Estado: `savedImages` ya viven en backend ({id, url, position}). `pendingFiles`
      // son File objects pickeados localmente que se subirán DESPUÉS de crear el producto en backend.
      const savedImages = []; // {id, url}
      const pendingFiles = []; // File
      const objectUrls = new Map(); // File -> object URL (para revocar al cerrar)

      const renderImageThumbs = () => {
        const thumbs = el.querySelector('#tn-images-thumbs');
        if (!thumbs) return;
        const items = [
          ...savedImages.map((img) => ({ kind: 'saved', id: img.id, url: img.url })),
          ...pendingFiles.map((f) => {
            let u = objectUrls.get(f);
            if (!u) { u = URL.createObjectURL(f); objectUrls.set(f, u); }
            return { kind: 'pending', file: f, url: u };
          }),
        ];
        if (items.length === 0) {
          thumbs.innerHTML = '';
          return;
        }
        thumbs.innerHTML = items.map((it, idx) => `
          <div class="relative w-20 h-20 rounded-lg overflow-hidden border border-[#e3ceba] bg-[#fff1e6]" data-img-idx="${idx}">
            <img src="${it.url}" alt="" class="w-full h-full object-cover" />
            ${it.kind === 'pending' ? '<span class="absolute bottom-0 left-0 right-0 text-[10px] text-center bg-black/50 text-white py-0.5">pendiente</span>' : ''}
            <button type="button" data-img-del="${idx}" class="absolute top-0 right-0 w-5 h-5 bg-red-600 text-white rounded-full text-xs leading-none hover:bg-red-700" title="Eliminar">×</button>
          </div>
        `).join('');
        thumbs.querySelectorAll('[data-img-del]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const i = Number(btn.dataset.imgDel);
            const it = items[i];
            if (!it) return;
            if (it.kind === 'saved') {
              try {
                const { api } = await import('../core/api.js');
                await api(`/api/images/${encodeURIComponent(it.id)}`, { method: 'DELETE' });
                const idx2 = savedImages.findIndex((x) => x.id === it.id);
                if (idx2 >= 0) savedImages.splice(idx2, 1);
              } catch (e) {
                console.warn('No se pudo borrar imagen', e);
                toast('No se pudo borrar la imagen', 'error');
                return;
              }
            } else {
              const idx2 = pendingFiles.indexOf(it.file);
              if (idx2 >= 0) pendingFiles.splice(idx2, 1);
              const u = objectUrls.get(it.file);
              if (u) { URL.revokeObjectURL(u); objectUrls.delete(it.file); }
            }
            renderImageThumbs();
          });
        });
      };

      // Si estamos editando un producto que ya existe en backend, traemos sus imágenes.
      const loadExistingImages = async () => {
        if (!isEdit) return;
        try {
          const { api } = await import('../core/api.js');
          const prod = await api(`/api/products/${encodeURIComponent(p.id)}`);
          for (const img of (prod?.images || [])) savedImages.push({ id: img.id, url: img.url });
          renderImageThumbs();
        } catch {
          // El producto puede no existir en backend todavía (nunca se publicó). Sin imágenes y listo.
        }
      };
      loadExistingImages();

      // File picker → si es edición e existe el producto en backend, subimos inmediatamente.
      // Si no, queueamos en pendingFiles para subir después del POST de creación.
      const imgInput = el.querySelector('#tn-image-input');
      imgInput?.addEventListener('change', async (ev) => {
        const files = Array.from(ev.target.files || []);
        ev.target.value = ''; // permite re-seleccionar el mismo archivo
        for (const f of files) {
          if (isEdit) {
            try {
              const { uploadFile } = await import('../core/api.js');
              const img = await uploadFile(`/api/products/${encodeURIComponent(p.id)}/images`, f);
              if (img?.id) savedImages.push({ id: img.id, url: img.url });
            } catch (e) {
              console.warn('Upload de imagen falló', e);
              toast(`No se pudo subir "${f.name}"`, 'error');
            }
          } else {
            pendingFiles.push(f);
          }
        }
        renderImageThumbs();
      });

      // Estado del lote
      const batch = [];

      // Toggle de modo (sólo en alta)
      let mode = 'single';
      const setMode = (m) => {
        mode = m;
        if (isEdit) return;
        const single = el.querySelector('#footer-single');
        const bMode  = el.querySelector('#footer-batch');
        const panel  = el.querySelector('#batch-panel');
        const keepWrap = el.querySelector('#keep-fields-wrapper');
        el.querySelectorAll('.mode-btn').forEach(b => {
          const active = b.dataset.mode === m;
          b.classList.toggle('bg-white', active);
          b.classList.toggle('text-[#d82f1e]', active);
          b.classList.toggle('shadow-sm', active);
          b.classList.toggle('text-[#7d6c5c]', !active);
        });
        if (m === 'batch') {
          single.classList.add('hidden');
          bMode.classList.remove('hidden');
          bMode.classList.add('flex');
          panel.classList.remove('hidden');
          if (keepWrap) { keepWrap.classList.remove('hidden'); keepWrap.classList.add('flex'); }
        } else {
          single.classList.remove('hidden');
          single.classList.add('flex');
          bMode.classList.add('hidden');
          bMode.classList.remove('flex');
          panel.classList.add('hidden');
          if (keepWrap) { keepWrap.classList.add('hidden'); keepWrap.classList.remove('flex'); }
        }
      };
      if (!isEdit) {
        el.querySelectorAll('.mode-btn').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
      }

      // Helpers
      const readForm = () => {
        const d = Object.fromEntries(new FormData(form).entries());
        d.published_meli = form.elements.published_meli.checked;
        d.published_tn = form.elements.published_tn.checked;
        // Campos de dinero: parsear tolerando formato argentino (1.234,56).
        for (const k of ['cost', 'price', 'margin_pct', 'promotional_price']) {
          if (d[k] !== undefined && d[k] !== '') d[k] = parseNumAR(d[k]) ?? 0;
        }
        const qtyLomas = Math.max(0, parseNumAR(d.stock_lomas) ?? 0);
        const qtyBanf  = Math.max(0, parseNumAR(d.stock_banfield) ?? 0);
        delete d.stock_lomas; delete d.stock_banfield;
        // Categorías TN seleccionadas (sólo importan si va a TN)
        const tnCatIds = Array.from(el.querySelectorAll('#tn-cats-box input[data-tn-cat]:checked'))
          .map((cb) => Number(cb.dataset.tnCat))
          .filter((n) => !Number.isNaN(n));
        d.tn_category_ids = tnCatIds;
        // Variantes (si el toggle está activo): un "tipo" + filas de valores.
        let variants = null;
        if (hasVarChk?.checked) {
          const type = (variantTypeIn?.value || '').trim() || 'Variante';
          variants = variantRows
            .filter((r) => String(r.valor).trim())
            .map((r) => ({
              id: r.id || null, type, valor: String(r.valor).trim(),
              code: (r.code || '').trim() || null, barcode: (r.barcode || '').trim() || null,
              price: r.price === '' || r.price == null ? null : Number(r.price),
              lomas: Math.max(0, Number(r.lomas) || 0), banf: Math.max(0, Number(r.banf) || 0),
            }));
        }
        return { d, qtyLomas, qtyBanf, variants };
      };

      const drainImages = async (saved) => {
        if (pendingFiles.length === 0) return;
        const { uploadFile } = await import('../core/api.js');
        for (const f of pendingFiles) {
          try {
            const img = await uploadFile(`/api/products/${encodeURIComponent(saved.id)}/images`, f);
            if (img?.id) savedImages.push({ id: img.id, url: img.url });
          } catch (err) {
            console.warn('Upload imagen falló', err);
            toast(`No se pudo subir "${f.name}"`, 'warn');
          }
        }
        pendingFiles.length = 0;
        renderImageThumbs();
      };

      const persistOne = async ({ d, qtyLomas, qtyBanf, variants }) => {
        if (!d.name?.trim()) { toast('Nombre requerido', 'error'); return null; }
        if (d.published_tn) {
          if ((Number(d.cost) || 0) <= 0) { toast('Para publicar en Tienda Nube el costo debe ser mayor a 0', 'error'); return null; }
          if ((Number(d.price) || 0) <= 0) { toast('Para publicar en Tienda Nube el precio debe ser mayor a 0', 'error'); return null; }
        }

        // --- Con variantes ---
        if (variants && variants.length) {
          if (!isEdit) {
            // Alta: createProduct con variants[] (cada una con su stock por sucursal).
            const saved = await P.save({ ...d, variants: variants.map((v) => ({
              name: v.valor, attributes: { [v.type]: v.valor }, code: v.code, barcode: v.barcode,
              price_override: parseNumAR(v.price), stocks: { br_lomas: v.lomas, br_banfield: v.banf },
            })) });
            await drainImages(saved);
            return saved;
          }
          // Edición: actualizar producto + diff de variantes (el backend sincroniza a TN solo).
          const saved = await P.save({ ...(p || {}), ...d });
          const formIds = new Set(variants.filter((v) => v.id).map((v) => v.id));
          for (const ev of (p?.variants || [])) {
            if (!formIds.has(ev.id)) {
              try { await P.removeVariant(ev.id); }
              catch { toast(`No se pudo borrar la variante "${ev.name}" (¿tiene ventas?)`, 'warn'); }
            }
          }
          for (const v of variants) {
            const attrs = { [v.type]: v.valor };
            let vid = v.id;
            if (vid) {
              await P.updateVariant(vid, { name: v.valor, attributes: attrs, code: v.code, barcode: v.barcode, priceOverride: parseNumAR(v.price) });
            } else {
              const nv = await P.createVariant({ productId: saved.id, name: v.valor, attributes: attrs, code: v.code, barcode: v.barcode, priceOverride: parseNumAR(v.price) });
              vid = nv?.id;
            }
            if (vid) {
              await P.setStock(saved.id, 'br_lomas',    { qty: v.lomas, variantId: vid, reason: 'Ajuste variante' });
              await P.setStock(saved.id, 'br_banfield', { qty: v.banf,  variantId: vid, reason: 'Ajuste variante' });
            }
          }
          await drainImages(saved);
          return saved;
        }

        // --- Producto simple (sin variantes) ---
        const saved = await P.save({ ...(p || {}), ...d });
        await P.setStock(saved.id, 'br_lomas',    { qty: qtyLomas, reason: isEdit ? 'Ajuste desde inventario' : 'Stock inicial' });
        await P.setStock(saved.id, 'br_banfield', { qty: qtyBanf,  reason: isEdit ? 'Ajuste desde inventario' : 'Stock inicial' });
        await drainImages(saved);
        return saved;
      };

      const resetForBatch = (keepFields) => {
        form.elements.name.value = '';
        form.elements.code.value = '';
        form.elements.cost.value = 0;
        form.elements.margin_pct.value = 0;
        form.elements.price.value = 0;
        form.elements.stock_lomas.value = 0;
        form.elements.stock_banfield.value = 0;
        // Variantes: limpiar valores cargados (mantener el "tipo" sticky para el lote).
        variantRows.length = 0;
        drawVariantRows();
        if (hasVarChk?.checked) { variantRows.push({ valor: '', code: '', barcode: '', price: '', lomas: 0, banf: 0 }); drawVariantRows(); }
        // En lote, dejamos sticky los checkboxes de publicación: si querés publicar
        // todo el lote a TN/MELI tildás una vez y queda. Desactivá manualmente para excepciones.
        // Limpiamos los campos específicos del producto que NO son categorización.
        const clearIfPresent = (name) => { const e = form.elements[name]; if (e) e.value = ''; };
        ['description', 'promotional_price', 'weight', 'width', 'height', 'depth',
         'seo_title', 'seo_description', 'handle', 'video_url'].forEach(clearIfPresent);
        // Limpiamos imágenes (las del producto anterior ya están subidas a backend con su ID).
        savedImages.length = 0;
        for (const u of objectUrls.values()) URL.revokeObjectURL(u);
        objectUrls.clear();
        pendingFiles.length = 0;
        renderImageThumbs();
        // Categorías TN: el checkbox "Mantener categorías de Tienda Nube" controla
        // si las dejamos tildadas para el siguiente o las destildamos todas.
        const keepTnCats = el.querySelector('#keep-tn-cats')?.checked ?? true;
        if (!keepTnCats) {
          el.querySelectorAll('#tn-cats-box input[data-tn-cat]:checked').forEach((cb) => { cb.checked = false; });
        }
        if (!keepFields) {
          form.elements.category_id.value = '';
          form.elements.brand_id.value = '';
          form.elements.supplier_id.value = '';
          form.elements.subcategory_id.value = '';
        }
        setTimeout(() => form.elements.name.focus(), 30);
      };

      const renderBatchList = () => {
        const listEl = el.querySelector('#batch-list');
        const countEl = el.querySelector('#batch-count');
        if (!listEl) return;
        countEl.textContent = String(batch.length);
        if (batch.length === 0) {
          listEl.innerHTML = '<div class="text-[#7d6c5c] italic">Sin productos cargados aún</div>';
          return;
        }
        listEl.innerHTML = `
          <div class="max-h-48 overflow-auto rounded-xl border border-[#e3ceba] bg-white">
            <table class="w-full text-sm">
              <thead><tr class="bg-[#fff1e6] text-[#7d6c5c]">
                <th class="text-left py-2 px-3 w-8">#</th>
                <th class="text-left py-2 px-3">Nombre</th>
                <th class="text-right py-2 px-3">Costo</th>
                <th class="text-right py-2 px-3">Precio</th>
                <th class="text-center py-2 px-3">TN</th>
              </tr></thead>
              <tbody>
                ${batch.map((b, i) => `
                  <tr class="border-t border-[#fff1e6]">
                    <td class="py-2 px-3 text-[#7d6c5c]">${i+1}</td>
                    <td class="py-2 px-3 font-bold">${b.name}</td>
                    <td class="py-2 px-3 text-right">${money(b.cost)}</td>
                    <td class="py-2 px-3 text-right font-bold">${money(b.price)}</td>
                    <td class="py-2 px-3 text-center">${b.tn ? '<span class="text-[#d82f1e] font-black">✓</span>' : '<span class="text-[#7d6c5c]">—</span>'}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>`;
      };

      // Acciones modo "single"
      el.querySelector('[data-act="cancel"]').addEventListener('click', () => close(null));
      el.querySelector('[data-act="save"]').addEventListener('click', async (ev) => {
        const btn = ev.currentTarget;
        if (btn.disabled) return;
        btn.disabled = true;
        try {
          const payload = readForm();
          const saved = await persistOne(payload);
          if (!saved) return;
          toast(isEdit ? 'Actualizado' : 'Creado', 'success');
          close(saved);
          renderProducts(container);
        } catch (e) {
          toast(e?.message || 'No se pudo guardar el producto', 'error');
        } finally {
          btn.disabled = false;
        }
      });

      // Acciones modo "batch"
      if (!isEdit) {
        el.querySelector('[data-act="cancel-batch"]').addEventListener('click', () => {
          if (batch.length === 0) return close(null);
          confirmModal({ title: 'Cancelar lote', message: `Ya cargaste ${batch.length} producto(s). ¿Salir sin más cambios? (los ya cargados se mantienen)`, confirmLabel: 'Salir' })
            .then(ok => { if (ok) { close({ batch }); renderProducts(container); } });
        });
        el.querySelector('[data-act="save-and-continue"]').addEventListener('click', async (ev) => {
          const btn = ev.currentTarget;
          if (btn.disabled) return;
          btn.disabled = true;
          try {
            const payload = readForm();
            const saved = await persistOne(payload);
            if (!saved) return;
            batch.push({
              id: saved.id, name: saved.name, code: saved.code,
              cost: saved.cost, price: saved.price,
              stockLomas: payload.qtyLomas, stockBanf: payload.qtyBanf,
              tn: !!payload.d.published_tn,
            });
            toast(`Agregado al lote (${batch.length})`, 'success');
            renderBatchList();
            const keep = el.querySelector('#keep-fields')?.checked ?? true;
            resetForBatch(keep);
          } catch (e) {
            // Sin esto, un error del backend (p. ej. código duplicado) dejaba la UI
            // "trabada" sin feedback. Mostramos el motivo y liberamos el botón.
            toast(e?.message || 'No se pudo agregar el producto', 'error');
          } finally {
            btn.disabled = false;
          }
        });
        el.querySelector('[data-act="finish-batch"]').addEventListener('click', async (ev) => {
          const btn = ev.currentTarget;
          if (btn.disabled) return;
          btn.disabled = true;
          try {
            // Si el formulario tiene un nombre cargado, intentamos guardarlo también antes de cerrar.
            if (form.elements.name.value.trim()) {
              const payload = readForm();
              const saved = await persistOne(payload);
              if (saved) {
                batch.push({
                  id: saved.id, name: saved.name, code: saved.code, price: saved.price,
                  stockLomas: payload.qtyLomas, stockBanf: payload.qtyBanf,
                  tn: !!payload.d.published_tn,
                });
              } else {
                // El último producto no se pudo guardar: no cerramos, dejamos que corrija.
                return;
              }
            }
            if (batch.length === 0) { toast('No agregaste ningún producto', 'warn'); return; }
            toast(`Lote terminado: ${batch.length} producto(s) creado(s)`, 'success');
            close({ batch });
            renderProducts(container);
          } catch (e) {
            toast(e?.message || 'No se pudo terminar el lote', 'error');
          } finally {
            btn.disabled = false;
          }
        });
      }
    },
  });
}

// Modal para vincular un producto del sistema con uno de Tienda Nube (busca en el catálogo TN).
async function openTnLinkModal(product, container) {
  await openModal({
    title: `Vincular con Tienda Nube · ${product.name}`,
    size: 'lg',
    bodyHTML: `
      <input id="tnl-q" class="ing-input w-full mb-2" placeholder="Buscar en Tienda Nube (nombre, barcode o SKU)…" />
      <div id="tnl-list" class="max-h-[55vh] overflow-auto border border-[#fff1e6] rounded-xl divide-y divide-[#fff1e6]"><div class="p-4 text-center text-[#7d6c5c]">Cargando catálogo de Tienda Nube…</div></div>
      <p class="text-xs text-[#7d6c5c] mt-2">Elegí el producto de TN que corresponde. Se vincula y el stock se sincroniza automáticamente.</p>`,
    footerHTML: `<button class="ing-btn-secondary" data-act="close">Cerrar</button>`,
    onOpen: async (el, close) => {
      el.querySelector('[data-act="close"]').addEventListener('click', () => close(null));
      const listEl = el.querySelector('#tnl-list');
      let catalog = [];
      try { catalog = await P.getTnCatalog(); }
      catch { listEl.innerHTML = '<div class="p-4 text-center text-red-600">No se pudo cargar el catálogo de TN (¿conectada?).</div>'; return; }
      const draw = (q) => {
        const ql = (q || '').trim().toLowerCase();
        let rows;
        if (ql) rows = catalog.filter(r => (r.name || '').toLowerCase().includes(ql) || (r.barcode || '').includes(ql) || (r.sku || '').toLowerCase().includes(ql));
        else { const seed = (product.name || '').toLowerCase().slice(0, 12); rows = catalog.filter(r => (r.name || '').toLowerCase().includes(seed)); }
        rows = rows.slice(0, 60);
        listEl.innerHTML = rows.length ? rows.map(r => `
          <button data-tnp="${r.tnProductId}" data-tnv="${r.tnVariantId}" class="w-full flex items-center justify-between gap-3 px-3 py-2 hover:bg-[#fff8f4] text-left">
            <div class="min-w-0"><div class="font-bold text-sm break-words leading-tight">${escapeAttr(r.name)}</div><div class="text-xs text-[#7d6c5c] font-mono">${escapeAttr(r.barcode || r.sku || '')}${r.isVariant ? ' · (con variantes)' : ''}</div></div>
            <div class="font-bold text-[#d82f1e] whitespace-nowrap">${r.price ? ('$' + r.price) : ''}</div>
          </button>`).join('') : '<div class="p-4 text-center text-[#7d6c5c]">Sin resultados</div>';
        listEl.querySelectorAll('[data-tnp]').forEach(btn => btn.addEventListener('click', async () => {
          try {
            if (product.has_variants) {
              // Producto con variantes: emparejar variante↔variante en el backend.
              const rep = await P.linkTnVariants(product.id, btn.dataset.tnp);
              const nl = (rep.unmatchedLocal || []).length, nt = (rep.unmatchedTn || []).length;
              if (nl || nt) {
                toast(`Vinculadas ${rep.linked} variante(s). Sin casar: ${nl} del sistema, ${nt} de TN (revisar).`, 'info');
              } else {
                toast(`Vinculadas ${rep.linked} variante(s) con Tienda Nube`, 'success');
              }
            } else {
              await P.linkTn(product.id, btn.dataset.tnp, btn.dataset.tnv);
              toast('Vinculado a Tienda Nube', 'success');
            }
            close(true); renderProducts(container);
          } catch (e) { toast('No se pudo vincular: ' + (e.message || ''), 'error'); }
        }));
      };
      const qIn = el.querySelector('#tnl-q');
      qIn.addEventListener('input', () => draw(qIn.value));
      draw(''); qIn.focus();
    },
  });
}

function openColumnsModal(cols, container) {
  const body = `
    <div class="space-y-2">
      ${cols.map(c => `
        <label class="flex items-center gap-3 p-2 hover:bg-[#fff1e6] rounded-xl cursor-pointer">
          <input type="checkbox" data-col="${c.id}" ${state.visibleCols.has(c.id)?'checked':''} class="rounded text-[#d82f1e] focus:ring-[#d82f1e]" />
          <span class="font-semibold">${c.label}</span>
        </label>
      `).join('')}
    </div>
  `;
  openModal({
    title: 'Mostrar / ocultar columnas',
    bodyHTML: body,
    footerHTML: `<button class="ing-btn-primary" data-act="ok">Aplicar</button>`,
    size: 'sm',
    onOpen: (el, close) => {
      el.querySelector('[data-act="ok"]').addEventListener('click', () => {
        state.visibleCols = new Set(Array.from(el.querySelectorAll('[data-col]:checked')).map(x => x.dataset.col));
        close(true);
        renderProducts(container);
      });
    },
  });
}

async function bulkSetMeli(flag, container) {
  for (const id of state.selected) {
    const p = await P.byId(id);
    if (p) { p.published_meli = flag; await P.save(p); }
  }
  toast(`${state.selected.size} producto(s) ${flag?'publicado(s)':'despublicado(s)'}`, 'success');
  state.selected.clear();
  renderProducts(container);
}

async function bulkPricePct(container) {
  const pctStr = prompt('Ajuste % a aplicar sobre el PRECIO (ej: 10 para +10%, -5 para -5%)');
  if (pctStr === null) return;
  const pct = Number(pctStr);
  if (Number.isNaN(pct)) { toast('Valor inválido', 'error'); return; }
  for (const id of state.selected) {
    const p = await P.byId(id);
    if (!p) continue;
    p.price = +(p.price * (1 + pct / 100)).toFixed(2);
    if (p.cost > 0) p.margin_pct = +((p.price / p.cost - 1) * 100).toFixed(2);
    await P.save(p);
  }
  toast(`${state.selected.size} precios actualizados`, 'success');
  state.selected.clear();
  renderProducts(container);
}

async function bulkDelete(container) {
  const ok = await confirmModal({ title:'Eliminar múltiples', message:`¿Eliminar ${state.selected.size} productos?`, danger:true, confirmLabel:'Eliminar' });
  if (!ok) return;
  for (const id of state.selected) await P.remove(id);
  toast('Productos eliminados', 'success');
  state.selected.clear();
  renderProducts(container);
}

// Edición masiva de campos: aplica los campos tildados a TODOS los seleccionados.
async function bulkEditFields(container) {
  const n = state.selected.size;
  if (!n) return;
  const cats = [...(state.cache?.categories || [])].sort(byName);
  const brs  = [...(state.cache?.brands || [])].sort(byName);
  const sups = [...(state.cache?.suppliers || [])].sort(byName);
  const subs = [...(state.cache?.subcats || [])].sort(byName);
  const opts = (arr) => arr.map((x) => `<option value="${x.id}">${escapeAttr(x.name)}</option>`).join('');
  // Cada fila: checkbox "cambiar" + control (deshabilitado hasta tildar).
  const row = (key, label, controlHTML) => `
    <div class="flex items-center gap-3 py-2 border-b border-[#fff1e6]">
      <label class="flex items-center gap-2 w-40 shrink-0 cursor-pointer">
        <input type="checkbox" data-k="${key}" class="be-chk rounded text-[#d82f1e] focus:ring-[#d82f1e]" />
        <span class="text-sm font-bold text-[#241a0d]">${label}</span>
      </label>
      <div class="flex-1">${controlHTML}</div>
    </div>`;
  const bodyHTML = `
    <p class="text-sm text-[#7d6c5c] mb-3">Tildá los campos que querés cambiar en los <b>${n}</b> productos seleccionados. Los que no tildes quedan como están.</p>
    ${row('category_id', 'Categoría', `<select data-f="category_id" class="ing-input w-full" disabled><option value="">— sin categoría —</option>${opts(cats)}</select>`)}
    ${row('subcategory_id', 'Subcategoría', `<select data-f="subcategory_id" class="ing-input w-full" disabled><option value="">— sin subcategoría —</option>${opts(subs)}</select>`)}
    ${row('brand_id', 'Marca', `<select data-f="brand_id" class="ing-input w-full" disabled><option value="">— sin marca —</option>${opts(brs)}</select>`)}
    ${row('supplier_id', 'Proveedor', `<select data-f="supplier_id" class="ing-input w-full" disabled><option value="">— sin proveedor —</option>${opts(sups)}</select>`)}
    ${row('cost', 'Costo', `<input data-f="cost" type="text" inputmode="decimal" class="ing-input w-full" placeholder="Ej: 1500" disabled />`)}
    ${row('price', 'Precio', `<input data-f="price" type="text" inputmode="decimal" class="ing-input w-full" placeholder="Ej: 3000" disabled />`)}
    ${row('margin_pct', '% Margen', `<input data-f="margin_pct" type="text" inputmode="decimal" class="ing-input w-full" placeholder="Ej: 100 (recalcula el precio)" disabled />`)}
    ${row('promotional_price', 'Precio promo', `<input data-f="promotional_price" type="text" inputmode="decimal" class="ing-input w-full" placeholder="Ej: 2500 (0 = sin promo)" disabled />`)}
    ${row('published_meli', 'Publicar en MELI', `<select data-f="published_meli" class="ing-input w-full" disabled><option value="1">Sí</option><option value="0">No</option></select>`)}
    ${row('published_tn', 'Publicar en Tienda Nube', `<select data-f="published_tn" class="ing-input w-full" disabled><option value="1">Sí</option><option value="0">No</option></select>`)}
    ${row('description', 'Descripción', `<textarea data-f="description" class="ing-input w-full" rows="2" placeholder="Texto para todos los seleccionados" disabled></textarea>`)}
    ${row('weight', 'Peso (kg)', `<input data-f="weight" type="text" inputmode="decimal" class="ing-input w-full" placeholder="Ej: 0.5" disabled />`)}
    ${row('width', 'Ancho (cm)', `<input data-f="width" type="text" inputmode="decimal" class="ing-input w-full" disabled />`)}
    ${row('height', 'Alto (cm)', `<input data-f="height" type="text" inputmode="decimal" class="ing-input w-full" disabled />`)}
    ${row('depth', 'Profundidad (cm)', `<input data-f="depth" type="text" inputmode="decimal" class="ing-input w-full" disabled />`)}
    <div id="be-progress" class="text-sm font-bold text-[#7d6c5c] mt-3 hidden"></div>`;
  const footerHTML = `
    <button class="ing-btn-secondary" data-act="cancel">Cancelar</button>
    <button class="ing-btn-primary" data-act="apply">Aplicar a ${n} productos</button>`;

  await openModal({
    title: 'Editar campos en masa', size: 'md', bodyHTML, footerHTML,
    onOpen: (el, close) => {
      // Habilitar/deshabilitar cada control según su checkbox.
      el.querySelectorAll('.be-chk').forEach((chk) => {
        const ctrl = el.querySelector(`[data-f="${chk.dataset.k}"]`);
        chk.addEventListener('change', () => { ctrl.disabled = !chk.checked; if (chk.checked) ctrl.focus(); });
      });
      el.querySelector('[data-act="cancel"]').addEventListener('click', () => close(null));
      el.querySelector('[data-act="apply"]').addEventListener('click', async (ev) => {
        // Recolectar los campos tildados.
        const changes = {};
        el.querySelectorAll('.be-chk:checked').forEach((chk) => {
          const k = chk.dataset.k;
          const ctrl = el.querySelector(`[data-f="${k}"]`);
          changes[k] = ctrl.value;
        });
        if (Object.keys(changes).length === 0) { toast('No tildaste ningún campo', 'warn'); return; }

        const btn = ev.currentTarget; btn.disabled = true;
        const prog = el.querySelector('#be-progress'); prog.classList.remove('hidden');
        const ids = [...state.selected];
        let done = 0, failed = 0;
        for (const id of ids) {
          try {
            const p = await P.byId(id);
            if (!p) { failed++; continue; }
            if ('category_id' in changes) p.category_id = changes.category_id || null;
            if ('subcategory_id' in changes) p.subcategory_id = changes.subcategory_id || null;
            if ('brand_id' in changes) p.brand_id = changes.brand_id || null;
            if ('supplier_id' in changes) p.supplier_id = changes.supplier_id || null;
            if ('published_meli' in changes) p.published_meli = changes.published_meli === '1';
            if ('published_tn' in changes) p.published_tn = changes.published_tn === '1';
            if ('description' in changes) p.description = changes.description;
            if ('promotional_price' in changes) { const v = parseNumAR(changes.promotional_price); p.promotional_price = (v != null && v > 0) ? v : null; }
            if ('weight' in changes) { const v = parseNumAR(changes.weight); p.weight = v != null ? v : null; }
            if ('width' in changes) { const v = parseNumAR(changes.width); p.width = v != null ? v : null; }
            if ('height' in changes) { const v = parseNumAR(changes.height); p.height = v != null ? v : null; }
            if ('depth' in changes) { const v = parseNumAR(changes.depth); p.depth = v != null ? v : null; }
            if ('cost' in changes) { const v = parseNumAR(changes.cost); if (v != null) p.cost = v; }
            // %Margen tiene prioridad: recalcula el precio desde el costo. Si no, precio directo.
            if ('margin_pct' in changes) {
              const m = parseNumAR(changes.margin_pct);
              if (m != null) { p.margin_pct = m; if (p.cost > 0) p.price = roundPrice(p.cost * (1 + m / 100)); }
            } else if ('price' in changes) {
              const v = parseNumAR(changes.price);
              if (v != null) { p.price = v; if (p.cost > 0) p.margin_pct = +((p.price / p.cost - 1) * 100).toFixed(2); }
            }
            await P.save(p);
            done++;
          } catch { failed++; }
          prog.textContent = `Actualizando… ${done + failed}/${ids.length}`;
        }
        toast(`${done} producto(s) actualizado(s)${failed ? ` · ${failed} con error` : ''}`, failed ? 'warn' : 'success');
        close(true);
        state.selected.clear();
        renderProducts(container);
      });
    },
  });
}

// ==================== CATÁLOGO (cat/brand/supplier/subcat) ====================
async function renderCatalog(container, title, repo, entityLabel, withParentCat = false) {
  const [items, cats] = await Promise.all([repo.list(), withParentCat ? Categories.list() : Promise.resolve([])]);
  const catMap = Object.fromEntries(cats.map(c => [c.id, c.name]));
  container.innerHTML = `
    <div class="flex justify-between items-center mb-4">
      <h2 class="text-xl font-black">${title} (${items.length})</h2>
      <button id="cat-new" class="ing-btn-primary text-sm"><span class="material-symbols-outlined align-middle text-base">add</span> Nuevo</button>
    </div>
    <div class="ing-card overflow-auto">
      <table class="ing-table w-full">
        <thead><tr><th>Nombre</th>${withParentCat?'<th>Categoría padre</th>':''}${entityLabel==='proveedor'?'<th>CUIT</th><th>Teléfono</th>':''}<th class="text-right">Acciones</th></tr></thead>
        <tbody>
          ${items.length === 0 ? `<tr><td colspan="4" class="text-center py-6 text-[#7d6c5c]">Sin registros</td></tr>` :
            items.map(i => `
              <tr data-id="${i.id}" class="group">
                <td class="font-bold">${i.name}</td>
                ${withParentCat ? `<td>${catMap[i.category_id] || '-'}</td>` : ''}
                ${entityLabel==='proveedor' ? `<td>${i.cuit || '-'}</td><td>${i.phone || '-'}</td>` : ''}
                <td class="text-right">
                  <button data-edit="${i.id}" class="opacity-0 group-hover:opacity-100 p-1.5 hover:bg-[#fff1e6] rounded-full"><span class="material-symbols-outlined text-base">edit</span></button>
                  <button data-del="${i.id}"  class="opacity-0 group-hover:opacity-100 p-1.5 hover:bg-red-50 rounded-full"><span class="material-symbols-outlined text-base text-red-500">delete</span></button>
                </td>
              </tr>
            `).join('')}
        </tbody>
      </table>
    </div>
  `;
  container.querySelector('#cat-new').addEventListener('click', () => openCatalogForm(null, title, repo, entityLabel, withParentCat, container));
  container.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', async () => {
    const i = items.find(x => x.id === b.dataset.edit);
    openCatalogForm(i, title, repo, entityLabel, withParentCat, container);
  }));
  container.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    const i = items.find(x => x.id === b.dataset.del);
    if (!await confirmModal({ title:'Eliminar', message:`¿Eliminar "${i.name}"?`, danger:true })) return;
    await repo.remove(i.id);
    toast('Eliminado', 'success');
    renderCatalog(container, title, repo, entityLabel, withParentCat);
  }));
}

async function openCatalogForm(item, title, repo, entityLabel, withParentCat, container) {
  const cats = withParentCat ? await Categories.list() : [];
  const body = `
    <form id="cat-form" class="space-y-3">
      <label class="block"><span class="text-xs font-black text-[#7d6c5c] uppercase">Nombre *</span>
        <input name="name" class="ing-input mt-1" required value="${item?.name || ''}" />
      </label>
      ${withParentCat ? `
        <label class="block"><span class="text-xs font-black text-[#7d6c5c] uppercase">Categoría padre</span>
          <select name="category_id" class="ing-input mt-1">
            <option value="">--</option>
            ${cats.map(c => `<option value="${c.id}" ${item?.category_id===c.id?'selected':''}>${c.name}</option>`).join('')}
          </select>
        </label>` : ''}
      ${entityLabel==='proveedor' ? `
        <label class="block"><span class="text-xs font-black text-[#7d6c5c] uppercase">CUIT</span>
          <input name="cuit" class="ing-input mt-1" value="${item?.cuit || ''}" />
        </label>
        <label class="block"><span class="text-xs font-black text-[#7d6c5c] uppercase">Teléfono</span>
          <input name="phone" class="ing-input mt-1" value="${item?.phone || ''}" />
        </label>
        <label class="block"><span class="text-xs font-black text-[#7d6c5c] uppercase">Notas</span>
          <textarea name="notes" class="ing-input mt-1" rows="2">${item?.notes || ''}</textarea>
        </label>` : ''}
    </form>`;
  openModal({
    title: (item ? 'Editar ' : 'Nuevo ') + title.toLowerCase().replace(/s$/, ''),
    bodyHTML: body,
    footerHTML: `<button class="ing-btn-secondary" data-act="cancel">Cancelar</button><button class="ing-btn-primary" data-act="save">Guardar</button>`,
    onOpen: (el, close) => {
      el.querySelector('[data-act="cancel"]').addEventListener('click', () => close(null));
      el.querySelector('[data-act="save"]').addEventListener('click', async () => {
        const d = Object.fromEntries(new FormData(el.querySelector('#cat-form')).entries());
        if (!d.name?.trim()) { toast('Nombre requerido', 'error'); return; }
        await repo.save({ ...(item || {}), ...d });
        toast('Guardado', 'success');
        close(true);
        renderCatalog(container, title, repo, entityLabel, withParentCat);
      });
    },
  });
}

// ==================== TRANSFERENCIAS ====================
// Mapea una transferencia del backend al shape que usan la tabla y el remito.
function toFrontTransfer(t) {
  return {
    id: t.id,
    number: t.number,
    remito_number: `R-${String(t.number).padStart(6, '0')}`,
    datetime: t.datetime,
    from_branch: t.fromBranch,
    to_branch: t.toBranch,
    items: t.items || [],
    notes: t.notes || null,
    status: t.status || 'confirmed',
    confirmed_at: t.confirmedAt || null,
    reason: t.reason || null,
  };
}

// Filtros del módulo de transferencias (se conservan entre re-renders).
const transferFilters = { from: '', to: '', branch: '', status: '' };
const TR_STATUS = {
  pending:   { label: 'Pendiente', cls: 'bg-amber-100 text-amber-700' },
  confirmed: { label: 'Confirmada', cls: 'bg-green-100 text-green-700' },
  rejected:  { label: 'Rechazada', cls: 'bg-red-100 text-red-700' },
  cancelled: { label: 'Cancelada', cls: 'bg-gray-200 text-gray-600' },
};

async function renderTransfers(container) {
  const qs = new URLSearchParams();
  if (transferFilters.branch) qs.set('branchId', transferFilters.branch);
  if (transferFilters.status) qs.set('status', transferFilters.status);
  if (transferFilters.from) qs.set('from', transferFilters.from);
  if (transferFilters.to) qs.set('to', new Date(new Date(transferFilters.to).getTime() + 86400000).toISOString().slice(0, 10));
  const [transfersRaw, branches, products, localTransfers] = await Promise.all([
    api('/api/transfers?' + qs.toString()).catch(() => []),
    getAll('branches'), P.list(),
    getAll('transfers').catch(() => []),
  ]);
  const transfers = (transfersRaw || []).map(toFrontTransfer);
  const stocks = products.flatMap(p => p._stocks || []);
  const brMap = Object.fromEntries(branches.map(b => [b.id, b.name]));
  const pMap  = Object.fromEntries(products.map(p => [p.id, p]));
  // variantId -> producto, para resolver items nuevos (guardan variantId).
  const vMap = {};
  for (const p of products) for (const v of (p.variants || [])) vMap[v.id] = p;
  const me = activeBranchId();
  const pendingForMe = transfers.filter(t => t.status === 'pending' && t.to_branch === me).length;

  container.innerHTML = `
    ${localTransfers.length ? `
    <div class="ing-card p-3 mb-4 border-l-4 border-amber-500 bg-amber-50 flex items-center justify-between gap-3 flex-wrap">
      <div class="text-sm text-[#241a0d]"><b>${localTransfers.length} transferencia(s)</b> quedaron guardadas solo en esta PC (registro). El stock de esas ya se movió; esto sube el remito al servidor para el historial compartido.</div>
      <button id="tr-migrate" class="ing-btn-secondary !py-1.5 !px-3 text-sm shrink-0">Archivar registro local</button>
    </div>` : ''}
    <div class="flex justify-between items-center mb-3 flex-wrap gap-2">
      <h2 class="text-xl font-black">Transferencias entre sucursales${pendingForMe ? ` · <span class="text-amber-600">${pendingForMe} pendiente(s) de recibir</span>` : ''}</h2>
      <button id="tr-new" class="ing-btn-primary text-sm"><span class="material-symbols-outlined align-middle text-base">add</span> Nueva transferencia</button>
    </div>
    <div class="ing-card p-2.5 mb-4">
      <div class="flex flex-wrap gap-1.5 items-center">
        <input id="trf-from" type="date" value="${transferFilters.from}" class="ing-filter" title="Desde" />
        <input id="trf-to" type="date" value="${transferFilters.to}" class="ing-filter" title="Hasta" />
        <select id="trf-branch" class="ing-filter">
          <option value="">Todas las sucursales</option>
          ${branches.map(b => `<option value="${b.id}" ${transferFilters.branch===b.id?'selected':''}>${b.name}</option>`).join('')}
        </select>
        <select id="trf-status" class="ing-filter">
          <option value="">Todos los estados</option>
          ${Object.entries(TR_STATUS).map(([k,v]) => `<option value="${k}" ${transferFilters.status===k?'selected':''}>${v.label}</option>`).join('')}
        </select>
        <button id="trf-clear" class="text-xs font-bold text-[#7d6c5c] hover:text-[#d82f1e] px-2">Limpiar</button>
      </div>
    </div>
    <div class="ing-card overflow-auto">
      <table class="ing-table w-full">
        <thead><tr><th>Remito</th><th>Fecha</th><th>De</th><th>A</th><th>Items</th><th>Estado</th><th class="text-right">Acciones</th></tr></thead>
        <tbody>
          ${transfers.length === 0 ? `<tr><td colspan="7" class="text-center py-6 text-[#7d6c5c]">Sin transferencias</td></tr>` :
            transfers.map(t => {
              const st = TR_STATUS[t.status] || { label: t.status, cls: 'bg-[#fff1e6] text-[#7d6c5c]' };
              const isDest = t.to_branch === me, isOrigin = t.from_branch === me;
              const acciones = [];
              if (t.status === 'pending' && isDest) {
                acciones.push(`<button data-confirm="${t.id}" class="ing-btn-primary !py-1 !px-2 text-xs">Recibir</button>`);
                acciones.push(`<button data-reject="${t.id}" class="ing-btn-secondary !py-1 !px-2 text-xs">Rechazar</button>`);
              }
              if (t.status === 'pending' && isOrigin) {
                acciones.push(`<button data-cancel="${t.id}" class="ing-btn-secondary !py-1 !px-2 text-xs">Cancelar</button>`);
              }
              acciones.push(`<button data-print="${t.id}" title="Remito" class="p-1.5 hover:bg-[#fff1e6] rounded-full"><span class="material-symbols-outlined text-base">print</span></button>`);
              return `
              <tr>
                <td class="font-mono font-bold text-[#d82f1e]">${t.remito_number}</td>
                <td class="text-xs">${new Date(t.datetime).toLocaleString('es-AR')}</td>
                <td>${brMap[t.from_branch] || '-'}</td>
                <td>${brMap[t.to_branch] || '-'}</td>
                <td>${t.items.length} producto(s)</td>
                <td><span class="px-2 py-1 rounded-full font-bold uppercase text-[10px] ${st.cls}">${st.label}</span></td>
                <td class="text-right"><div class="flex gap-1 justify-end items-center">${acciones.join('')}</div></td>
              </tr>`;
            }).join('')}
        </tbody>
      </table>
    </div>
  `;
  container.querySelector('#tr-new').addEventListener('click', () => openTransferForm(branches, products, stocks, container));
  // Filtros
  const onFilter = () => {
    transferFilters.from = container.querySelector('#trf-from').value;
    transferFilters.to = container.querySelector('#trf-to').value;
    transferFilters.branch = container.querySelector('#trf-branch').value;
    transferFilters.status = container.querySelector('#trf-status').value;
    renderTransfers(container);
  };
  ['trf-from','trf-to','trf-branch','trf-status'].forEach(id => container.querySelector('#'+id).addEventListener('change', onFilter));
  container.querySelector('#trf-clear').addEventListener('click', () => { transferFilters.from = transferFilters.to = transferFilters.branch = transferFilters.status = ''; renderTransfers(container); });
  // Acciones confirmar/rechazar/cancelar
  container.querySelectorAll('[data-confirm]').forEach(b => b.addEventListener('click', () => transferAction(b.dataset.confirm, 'confirm', container)));
  container.querySelectorAll('[data-reject]').forEach(b => b.addEventListener('click', () => transferAction(b.dataset.reject, 'reject', container)));
  container.querySelectorAll('[data-cancel]').forEach(b => b.addEventListener('click', () => transferAction(b.dataset.cancel, 'cancel', container)));
  container.querySelector('#tr-migrate')?.addEventListener('click', async (ev) => {
    ev.currentTarget.disabled = true;
    let done = 0, failed = 0;
    for (const t of localTransfers) {
      try {
        // SOLO el registro (el stock de estas ya se movió). No mueve stock ni toca TN.
        await api('/api/transfers/import', { method: 'POST', body: {
          fromBranch: t.from_branch, toBranch: t.to_branch,
          items: t.items || [], notes: t.notes || null, datetime: t.datetime || null,
        }});
        try { await del('transfers', t.id); } catch { /* noop */ }
        done++;
      } catch { failed++; }
    }
    toast(`Remitos archivados: ${done}${failed ? ` · con error: ${failed}` : ''}`, failed ? 'warn' : 'success');
    renderTransfers(container);
  });
  container.querySelectorAll('[data-print]').forEach(b => b.addEventListener('click', () => {
    const t = transfers.find(x => x.id === b.dataset.print);
    printTransfer(t, brMap, pMap, vMap);
  }));
}

// Confirmar / rechazar / cancelar una transferencia pendiente.
async function transferAction(id, action, container) {
  const labels = { confirm: ['Recibir transferencia', '¿Confirmás la recepción? Recién ahí se mueve el stock a esta sucursal.', 'Recibir', 'confirm'],
                   reject: ['Rechazar transferencia', '¿Rechazás esta transferencia? No se mueve stock.', 'Rechazar', 'reject'],
                   cancel: ['Cancelar transferencia', '¿Cancelás esta transferencia pendiente? No se mueve stock.', 'Cancelar', 'cancel'] };
  const [title, message, confirmLabel, ep] = labels[action];
  const ok = await confirmModal({ title, message, confirmLabel, danger: action !== 'confirm' });
  if (!ok) return;
  try {
    await api(`/api/transfers/${encodeURIComponent(id)}/${ep}`, { method: 'POST', body: {} });
    toast(action === 'confirm' ? 'Transferencia recibida · stock actualizado' : action === 'reject' ? 'Transferencia rechazada' : 'Transferencia cancelada', 'success');
    renderTransfers(container);
  } catch (e) {
    toast(e?.message || 'No se pudo completar la acción', 'error');
  }
}

async function openTransferForm(branches, products, stocks, container) {
  const body = `
    <form id="tr-form" class="space-y-4">
      <div class="grid grid-cols-2 gap-3">
        <label class="block"><span class="text-xs font-black text-[#7d6c5c] uppercase">Origen</span>
          <select name="from_branch" class="ing-input mt-1" required>
            ${branches.map(b => `<option value="${b.id}" ${b.id===activeBranchId()?'selected':''}>${b.name}</option>`).join('')}
          </select>
        </label>
        <label class="block"><span class="text-xs font-black text-[#7d6c5c] uppercase">Destino</span>
          <select name="to_branch" class="ing-input mt-1" required>
            ${branches.map(b => `<option value="${b.id}" ${b.id!==activeBranchId()?'selected':''}>${b.name}</option>`).join('')}
          </select>
        </label>
      </div>
      <div>
        <span class="text-xs font-black text-[#7d6c5c] uppercase block mb-2">Items</span>
        <div id="tr-items" class="space-y-2 max-h-[40vh] overflow-auto"></div>
        <button type="button" id="tr-add" class="mt-2 text-sm font-bold text-[#d82f1e] hover:underline">+ Agregar producto</button>
      </div>
    </form>`;
  openModal({
    title: 'Nueva transferencia (queda pendiente)',
    bodyHTML: body,
    footerHTML: `<button class="ing-btn-secondary" data-act="cancel">Cancelar</button><button class="ing-btn-primary" data-act="save">Generar transferencia</button>`,
    size: 'lg',
    onOpen: (el, close) => {
      const form = el.querySelector('#tr-form');
      const itemsDiv = el.querySelector('#tr-items');
      let items = [];
      const draw = () => {
        itemsDiv.innerHTML = items.map((it, idx) => `
          <div class="flex gap-2 items-center bg-[#fff1e6] p-2 rounded-xl">
            <select class="ing-input flex-1" data-idx="${idx}" data-k="product_id">
              <option value="">Elegir producto...</option>
              ${products.map(p => `<option value="${p.id}" ${it.product_id===p.id?'selected':''}>${p.code} · ${p.name}</option>`).join('')}
            </select>
            <input type="number" min="1" class="ing-input w-24" data-idx="${idx}" data-k="qty" value="${it.qty || 1}" />
            <button type="button" data-rm="${idx}" class="text-red-500 p-1"><span class="material-symbols-outlined text-base">close</span></button>
          </div>
        `).join('');
        itemsDiv.querySelectorAll('[data-k]').forEach(inp => inp.addEventListener('input', e => {
          items[+e.target.dataset.idx][e.target.dataset.k] = e.target.dataset.k === 'qty' ? Number(e.target.value) : e.target.value;
        }));
        itemsDiv.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => { items.splice(+b.dataset.rm, 1); draw(); }));
      };
      el.querySelector('#tr-add').addEventListener('click', () => { items.push({ product_id:'', qty:1 }); draw(); });

      el.querySelector('[data-act="cancel"]').addEventListener('click', () => close(null));
      el.querySelector('[data-act="save"]').addEventListener('click', async (ev) => {
        const from = form.elements.from_branch.value;
        const to   = form.elements.to_branch.value;
        if (from === to) { toast('Origen y destino deben ser distintos', 'error'); return; }
        if (items.length === 0 || items.some(i => !i.product_id || i.qty < 1)) { toast('Completá al menos un item', 'error'); return; }
        // Pre-chequeo de stock (el backend valida de forma atómica igual).
        for (const it of items) {
          const s = stocks.find(x => x.product_id === it.product_id && x.branch_id === from);
          if (!s || s.qty < it.qty) {
            const p = products.find(p => p.id === it.product_id);
            toast(`Stock insuficiente de "${p?.name}" en origen`, 'error');
            return;
          }
        }
        const btn = ev.currentTarget;
        if (btn.disabled) return;
        btn.disabled = true;
        try {
          // Resolver el variantId de cada producto (el backend mueve stock por variante).
          const apiItems = [];
          for (const it of items) {
            const variantId = await P.variantIdOf(it.product_id);
            if (!variantId) { toast('Un producto no tiene variante en el servidor', 'error'); btn.disabled = false; return; }
            apiItems.push({ variantId, product_id: it.product_id, qty: it.qty });
          }
          // Crea la transferencia PENDIENTE (no mueve stock hasta que el destino la reciba).
          const saved = await api('/api/transfers', { method: 'POST', body: { fromBranch: from, toBranch: to, items: apiItems } });
          const remito = `R-${String(saved.number).padStart(6, '0')}`;
          toast(`Transferencia ${remito} generada · pendiente de que la reciba el destino`, 'success');
          close(true);
          renderTransfers(container);
        } catch (e) {
          toast(e?.message || 'No se pudo confirmar la transferencia', 'error');
          btn.disabled = false;
        }
      });
    },
  });
}

function printTransfer(t, brMap, pMap, vMap = {}) {
  const stLabel = (TR_STATUS[t.status] || {}).label || t.status || '';
  const body = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start">
      <div>
        <div class="brand">Ingenium</div>
        <div class="muted">Sistema de Ventas</div>
      </div>
      <div style="text-align:right">
        <h1>REMITO INTERNO</h1>
        <div style="font-family:monospace;font-size:20px;font-weight:bold">${t.remito_number}</div>
        <div class="muted">${new Date(t.datetime).toLocaleString('es-AR')}</div>
        <div style="margin-top:4px;font-weight:bold">Estado: ${stLabel}</div>
      </div>
    </div>
    <div style="display:flex;gap:32px;margin:24px 0">
      <div><strong>De:</strong> ${brMap[t.from_branch] || t.from_branch}</div>
      <div><strong>A:</strong> ${brMap[t.to_branch] || t.to_branch}</div>
    </div>
    <table>
      <thead><tr><th>Código</th><th>Producto</th><th style="text-align:center">Cantidad</th></tr></thead>
      <tbody>
        ${t.items.map(it => {
          const p = vMap[it.variantId] || pMap[it.product_id] || {};
          return `<tr><td>${p.code || '-'}</td><td>${p.name || '-'}</td><td style="text-align:center">${it.qty}</td></tr>`;
        }).join('')}
      </tbody>
    </table>
    ${t.notes ? `<div style="margin-top:12px"><strong>Nota:</strong> ${t.notes}</div>` : ''}
    <div style="margin-top:40px;display:flex;justify-content:space-between;gap:40px">
      <div style="flex:1;border-top:1px solid #999;padding-top:6px;text-align:center" class="muted">Firma origen</div>
      <div style="flex:1;border-top:1px solid #999;padding-top:6px;text-align:center" class="muted">Firma recepción</div>
    </div>
    <div class="stamp">Traslado entre sucursales · Sin valor fiscal</div>
  `;
  printHTML({ title: `Remito ${t.remito_number}`, bodyHTML: body });
}
