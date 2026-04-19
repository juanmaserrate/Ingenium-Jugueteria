// Inventario — módulo completo.
// Tabs: Productos | Categorías | Marcas | Proveedores | Subcategorías | Transferencias.
// Productos: grilla con filtros, mostrar/ocultar columnas, edición inline (doble-click), bulk actions.

import * as P from '../repos/products.js';
import { Categories, Brands, Suppliers, Subcategories } from '../repos/catalog.js';
import { getAll, newId, put, tx, stockId, get } from '../core/db.js';
import { money } from '../core/format.js';
import { openModal, confirmModal } from '../components/modal.js';
import { toast } from '../core/notifications.js';
import { activeBranchId, currentSession } from '../core/auth.js';
import * as Audit from '../core/audit.js';
import { exportSimple } from '../core/xlsx.js';
import { next as nextCounter } from '../repos/counters.js';
import { printHTML } from '../core/pdf.js';

const state = {
  tab: 'products',
  selected: new Set(),
  filters: { search: '', category: '', brand: '', supplier: '', onlyMeli: false },
  visibleCols: new Set(['code', 'name', 'category', 'brand', 'supplier', 'cost', 'price', 'margin', 'stock_lomas', 'stock_banfield', 'total', 'meli']),
};

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
async function renderProducts(container) {
  const [products, stocks, categories, brands, suppliers, branches, subcats] = await Promise.all([
    P.list(), getAll('stock'), Categories.list(), Brands.list(), Suppliers.list(), getAll('branches'), Subcategories.list(),
  ]);
  const catMap = Object.fromEntries(categories.map(c => [c.id, c.name]));
  const brMap  = Object.fromEntries(brands.map(b => [b.id, b.name]));
  const spMap  = Object.fromEntries(suppliers.map(s => [s.id, s.name]));
  const stockOf = (pid, bid) => stocks.find(s => s.product_id === pid && s.branch_id === bid) || { qty: 0, reserved_qty: 0 };
  const lomas = branches.find(b => b.id === 'br_lomas');
  const banf = branches.find(b => b.id === 'br_banfield');

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
    return true;
  });

  const cols = [
    { id: 'code', label: 'Código', render: p => `<span class="font-mono text-xs text-[#7d6c5c]">${p.code}</span>` },
    { id: 'name', label: 'Nombre', render: p => `<span class="font-bold">${p.name}</span>`, editable: 'text' },
    { id: 'category', label: 'Categoría', render: p => catMap[p.category_id] || '-' },
    { id: 'brand', label: 'Marca', render: p => brMap[p.brand_id] || '-' },
    { id: 'supplier', label: 'Proveedor', render: p => spMap[p.supplier_id] || '-' },
    { id: 'cost', label: 'Costo', render: p => money(p.cost), align: 'right', editable: 'number', field: 'cost' },
    { id: 'margin', label: '% Margen', render: p => `${p.margin_pct}%`, align: 'right', editable: 'number', field: 'margin_pct' },
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
        <select id="f-category" class="ing-input max-w-[180px]">
          <option value="">Todas las categorías</option>
          ${categories.map(c => `<option value="${c.id}" ${f.category===c.id?'selected':''}>${c.name}</option>`).join('')}
        </select>
        <select id="f-brand" class="ing-input max-w-[180px]">
          <option value="">Todas las marcas</option>
          ${brands.map(b => `<option value="${b.id}" ${f.brand===b.id?'selected':''}>${b.name}</option>`).join('')}
        </select>
        <select id="f-supplier" class="ing-input max-w-[180px]">
          <option value="">Todos los proveedores</option>
          ${suppliers.map(s => `<option value="${s.id}" ${f.supplier===s.id?'selected':''}>${s.name}</option>`).join('')}
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
        <button id="btn-new" class="ing-btn-primary text-sm">
          <span class="material-symbols-outlined align-middle text-base">add</span> Nuevo
        </button>
      </div>

      <!-- Bulk actions bar -->
      <div id="bulk-bar" class="hidden mt-4 p-3 bg-[#fff1e6] rounded-2xl flex items-center gap-3 border border-[#e3ceba]">
        <span id="bulk-count" class="text-sm font-black text-[#d82f1e]"></span>
        <button id="bulk-meli-on" class="text-xs ing-btn-secondary !py-1.5 !px-3">Publicar en MELI</button>
        <button id="bulk-meli-off" class="text-xs ing-btn-secondary !py-1.5 !px-3">Despublicar MELI</button>
        <button id="bulk-price-pct" class="text-xs ing-btn-secondary !py-1.5 !px-3">Ajuste % precio</button>
        <button id="bulk-delete" class="text-xs px-3 py-1.5 rounded-full bg-red-50 text-red-600 font-bold hover:bg-red-100">Eliminar</button>
        <button id="bulk-clear" class="text-xs text-[#7d6c5c] hover:underline ml-auto">Deseleccionar</button>
      </div>
    </div>

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
            list.map(p => `
            <tr data-id="${p.id}" class="group">
              <td><input type="checkbox" class="row-check rounded text-[#d82f1e] focus:ring-[#d82f1e]" ${state.selected.has(p.id)?'checked':''} /></td>
              ${visibleCols.map(c => `<td class="${c.align==='right'?'text-right':c.align==='center'?'text-center':''}" ${c.editable?`data-editable="${c.editable}" data-field="${c.field||c.id}"`:''}>${c.render(p)}</td>`).join('')}
              <td class="text-right">
                <button data-edit="${p.id}" class="opacity-0 group-hover:opacity-100 p-1.5 hover:bg-[#fff1e6] rounded-full transition-all"><span class="material-symbols-outlined text-base text-[#7d6c5c]">edit</span></button>
                <button data-del="${p.id}"  class="opacity-0 group-hover:opacity-100 p-1.5 hover:bg-red-50 rounded-full transition-all"><span class="material-symbols-outlined text-base text-red-500">delete</span></button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    <p class="text-xs text-[#7d6c5c] mt-3">${list.length} producto(s) · doble-click para editar celdas editables (Nombre, Costo, %Margen, Precio)</p>
  `;

  // Filtros
  container.querySelector('#f-search').addEventListener('input', e => { state.filters.search = e.target.value; renderProducts(container); });
  container.querySelector('#f-category').addEventListener('change', e => { state.filters.category = e.target.value; renderProducts(container); });
  container.querySelector('#f-brand').addEventListener('change', e => { state.filters.brand = e.target.value; renderProducts(container); });
  container.querySelector('#f-supplier').addEventListener('change', e => { state.filters.supplier = e.target.value; renderProducts(container); });
  container.querySelector('#f-meli').addEventListener('change', e => { state.filters.onlyMeli = e.target.checked; renderProducts(container); });
  container.querySelector('#f-clear').addEventListener('click', () => { state.filters = { search:'', category:'', brand:'', supplier:'', onlyMeli:false }; renderProducts(container); });

  container.querySelector('#btn-new').addEventListener('click', () => openProductForm(null, container));
  container.querySelector('#btn-cols').addEventListener('click', () => openColumnsModal(cols, container));
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
  container.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    const p = list.find(x => x.id === b.dataset.del);
    const ok = await confirmModal({ title: 'Eliminar producto', message: `¿Eliminar "${p.name}"?`, danger: true, confirmLabel: 'Eliminar' });
    if (!ok) return;
    await P.remove(p.id);
    toast('Producto eliminado', 'success');
    renderProducts(container);
  }));

  // Edición inline
  container.querySelectorAll('[data-editable]').forEach(td => {
    td.addEventListener('dblclick', () => editInline(td, list, container));
  });

  // Bulk buttons
  const bulkBar = container.querySelector('#bulk-bar');
  bulkBar.querySelector('#bulk-clear').addEventListener('click', () => { state.selected.clear(); renderProducts(container); });
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
  const current = p[field] ?? '';
  const input = document.createElement('input');
  input.type = type === 'number' ? 'number' : 'text';
  input.step = '0.01';
  input.value = current;
  input.className = 'w-full p-1 border-2 border-[#d82f1e] rounded bg-white text-sm font-bold';
  td.innerHTML = '';
  td.appendChild(input);
  input.focus(); input.select();
  const save = async () => {
    let v = type === 'number' ? Number(input.value) : input.value;
    if (v === p[field]) { renderProducts(container); return; }
    p[field] = v;
    // Si cambió costo o %, recalcular precio. Si cambió precio, recalcular %.
    if (field === 'cost' || field === 'margin_pct') {
      p.price = +(p.cost * (1 + p.margin_pct / 100)).toFixed(2);
    } else if (field === 'price' && p.cost > 0) {
      p.margin_pct = +((p.price / p.cost - 1) * 100).toFixed(2);
    }
    await P.save(p);
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
  const [cats, brs, sps, subs] = await Promise.all([Categories.list(), Brands.list(), Suppliers.list(), Subcategories.list()]);
  const body = `
    <form id="prod-form" class="grid grid-cols-2 gap-4">
      <label class="col-span-2"><span class="text-xs font-black text-[#7d6c5c] uppercase">Nombre *</span>
        <input name="name" class="ing-input mt-1" required value="${p?.name || ''}" />
      </label>
      <label><span class="text-xs font-black text-[#7d6c5c] uppercase">Código</span>
        <input name="code" class="ing-input mt-1" value="${p?.code || ''}" />
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
      <label><span class="text-xs font-black text-[#7d6c5c] uppercase">Costo *</span>
        <input name="cost" type="number" step="0.01" class="ing-input mt-1" required value="${p?.cost || 0}" />
      </label>
      <label><span class="text-xs font-black text-[#7d6c5c] uppercase">% Margen</span>
        <input name="margin_pct" type="number" step="0.01" class="ing-input mt-1" value="${p?.margin_pct || 0}" />
      </label>
      <label><span class="text-xs font-black text-[#7d6c5c] uppercase">Precio</span>
        <input name="price" type="number" step="0.01" class="ing-input mt-1" value="${p?.price || 0}" />
      </label>
      <label class="col-span-2 flex items-center gap-2 py-2">
        <input type="checkbox" name="published_meli" ${p?.published_meli ? 'checked' : ''} class="rounded text-[#d82f1e] focus:ring-[#d82f1e]" />
        <span class="text-sm font-bold">Publicar en MercadoLibre</span>
      </label>
    </form>
  `;
  openModal({
    title: p ? 'Editar producto' : 'Nuevo producto',
    bodyHTML: body,
    footerHTML: `<button class="ing-btn-secondary" data-act="cancel">Cancelar</button><button class="ing-btn-primary" data-act="save">Guardar</button>`,
    size: 'lg',
    onOpen: (el, close) => {
      const form = el.querySelector('#prod-form');
      // Live recompute de precio cuando cambia costo o %
      const costIn = form.elements.cost, pctIn = form.elements.margin_pct, priceIn = form.elements.price;
      const recalcPrice = () => priceIn.value = (Number(costIn.value) * (1 + Number(pctIn.value)/100)).toFixed(2);
      const recalcPct = () => { if (Number(costIn.value) > 0) pctIn.value = ((Number(priceIn.value)/Number(costIn.value)-1)*100).toFixed(2); };
      costIn.addEventListener('input', recalcPrice);
      pctIn.addEventListener('input', recalcPrice);
      priceIn.addEventListener('input', recalcPct);

      el.querySelector('[data-act="cancel"]').addEventListener('click', () => close(null));
      el.querySelector('[data-act="save"]').addEventListener('click', async () => {
        const d = Object.fromEntries(new FormData(form).entries());
        d.published_meli = form.elements.published_meli.checked;
        if (!d.name?.trim()) { toast('Nombre requerido', 'error'); return; }
        const saved = await P.save({ ...(p || {}), ...d });
        toast(p ? 'Actualizado' : 'Creado', 'success');
        close(saved);
        renderProducts(container);
      });
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
    const p = await get('products', id);
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
    const p = await get('products', id);
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
async function renderTransfers(container) {
  const [transfers, branches, products, stocks] = await Promise.all([
    getAll('transfers'), getAll('branches'), P.list(), getAll('stock'),
  ]);
  const brMap = Object.fromEntries(branches.map(b => [b.id, b.name]));
  const pMap  = Object.fromEntries(products.map(p => [p.id, p]));

  container.innerHTML = `
    <div class="flex justify-between items-center mb-4">
      <h2 class="text-xl font-black">Transferencias entre sucursales (${transfers.length})</h2>
      <button id="tr-new" class="ing-btn-primary text-sm"><span class="material-symbols-outlined align-middle text-base">add</span> Nueva transferencia</button>
    </div>
    <div class="ing-card overflow-auto">
      <table class="ing-table w-full">
        <thead><tr><th>Remito</th><th>Fecha</th><th>De</th><th>A</th><th>Items</th><th class="text-right">Acciones</th></tr></thead>
        <tbody>
          ${transfers.length === 0 ? `<tr><td colspan="6" class="text-center py-6 text-[#7d6c5c]">Sin transferencias</td></tr>` :
            transfers.sort((a,b)=>b.datetime.localeCompare(a.datetime)).map(t => `
              <tr>
                <td class="font-mono font-bold text-[#d82f1e]">${t.remito_number}</td>
                <td class="text-xs">${new Date(t.datetime).toLocaleString('es-AR')}</td>
                <td>${brMap[t.from_branch] || '-'}</td>
                <td>${brMap[t.to_branch] || '-'}</td>
                <td>${t.items.length} producto(s)</td>
                <td class="text-right">
                  <button data-print="${t.id}" class="p-1.5 hover:bg-[#fff1e6] rounded-full"><span class="material-symbols-outlined text-base">print</span></button>
                </td>
              </tr>
            `).join('')}
        </tbody>
      </table>
    </div>
  `;
  container.querySelector('#tr-new').addEventListener('click', () => openTransferForm(branches, products, stocks, container));
  container.querySelectorAll('[data-print]').forEach(b => b.addEventListener('click', () => {
    const t = transfers.find(x => x.id === b.dataset.print);
    printTransfer(t, brMap, pMap);
  }));
}

async function openTransferForm(branches, products, stocks, container) {
  const body = `
    <form id="tr-form" class="space-y-4">
      <div class="grid grid-cols-2 gap-3">
        <label class="block"><span class="text-xs font-black text-[#7d6c5c] uppercase">Origen</span>
          <select name="from_branch" class="ing-input mt-1" required>
            ${branches.map(b => `<option value="${b.id}">${b.name}</option>`).join('')}
          </select>
        </label>
        <label class="block"><span class="text-xs font-black text-[#7d6c5c] uppercase">Destino</span>
          <select name="to_branch" class="ing-input mt-1" required>
            ${branches.map((b,i) => `<option value="${b.id}" ${i===1?'selected':''}>${b.name}</option>`).join('')}
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
    title: 'Nueva transferencia',
    bodyHTML: body,
    footerHTML: `<button class="ing-btn-secondary" data-act="cancel">Cancelar</button><button class="ing-btn-primary" data-act="save">Confirmar transferencia</button>`,
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
      el.querySelector('[data-act="save"]').addEventListener('click', async () => {
        const from = form.elements.from_branch.value;
        const to   = form.elements.to_branch.value;
        if (from === to) { toast('Origen y destino deben ser distintos', 'error'); return; }
        if (items.length === 0 || items.some(i => !i.product_id || i.qty < 1)) { toast('Completá al menos un item', 'error'); return; }
        // Validar stock
        for (const it of items) {
          const s = stocks.find(x => x.product_id === it.product_id && x.branch_id === from);
          if (!s || s.qty < it.qty) {
            const p = products.find(p => p.id === it.product_id);
            toast(`Stock insuficiente de "${p?.name}" en origen`, 'error');
            return;
          }
        }
        const session = currentSession();
        const number = await nextCounter('transfer_number');
        const remito = `R-${String(number).padStart(6, '0')}`;
        const t = {
          id: newId('tr'),
          remito_number: remito,
          datetime: new Date().toISOString(),
          from_branch: from, to_branch: to,
          items, user_id: session?.user_id,
        };
        // Ejecutar ajustes de stock
        for (const it of items) {
          await P.transferStock({ product_id: it.product_id, from_branch: from, to_branch: to, qty: it.qty });
        }
        await put('transfers', t);
        await Audit.log({
          action: 'transfer', entity: 'transferencia', entity_id: t.id,
          after: t, description: `Transferencia ${remito} · ${items.length} items · ${from}→${to}`,
        });
        const { push } = await import('../core/notifications.js');
        await push({ title: 'Transferencia recibida', body: `${remito} desde ${from}`, branch_id: to, type: 'info' });
        toast(`Transferencia ${remito} confirmada`, 'success');
        close(true);
        renderTransfers(container);
      });
    },
  });
}

function printTransfer(t, brMap, pMap) {
  const body = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start">
      <div>
        <div class="brand">Ingenium</div>
        <div class="muted">Sistema de Ventas</div>
      </div>
      <div style="text-align:right">
        <h1>REMITO</h1>
        <div style="font-family:monospace;font-size:20px;font-weight:bold">${t.remito_number}</div>
        <div class="muted">${new Date(t.datetime).toLocaleString('es-AR')}</div>
      </div>
    </div>
    <div style="display:flex;gap:32px;margin:24px 0">
      <div><strong>De:</strong> ${brMap[t.from_branch]}</div>
      <div><strong>A:</strong> ${brMap[t.to_branch]}</div>
    </div>
    <table>
      <thead><tr><th>Código</th><th>Producto</th><th style="text-align:center">Cantidad</th></tr></thead>
      <tbody>
        ${t.items.map(it => {
          const p = pMap[it.product_id] || {};
          return `<tr><td>${p.code || '-'}</td><td>${p.name || '-'}</td><td style="text-align:center">${it.qty}</td></tr>`;
        }).join('')}
      </tbody>
    </table>
    <div class="stamp">Traslado entre sucursales · Sin valor fiscal</div>
  `;
  printHTML({ title: `Remito ${t.remito_number}`, bodyHTML: body });
}
