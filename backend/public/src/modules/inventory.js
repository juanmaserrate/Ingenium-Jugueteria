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

// Escapa caracteres reservados para incrustar contenido en value="..." de un input.
function escapeAttr(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
    if (!p) return;
    const choice = await chooseDeleteScope(p);
    if (choice === 'cancel') return;
    try {
      if (choice === 'both') {
        const { api } = await import('../core/api.js');
        // Backend delete: enqueue push_product_delete en TN + borra producto local del POS server.
        await api(`/api/products/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
      }
      await P.remove(p.id);
      toast(choice === 'both' ? 'Eliminado del POS y Tienda Nube' : 'Eliminado del POS', 'success');
      renderProducts(container);
    } catch (e) {
      console.warn('delete falló', e);
      toast('No se pudo eliminar', 'error');
    }
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
      <label id="keep-fields-label" class="hidden items-center gap-2 cursor-pointer text-sm font-bold text-[#241a0d] bg-[#fff8f0] border border-[#e3ceba] rounded-2xl px-3 py-2">
        <input type="checkbox" id="keep-fields" checked class="rounded text-[#d82f1e] focus:ring-[#d82f1e]" />
        <span>Mantener Categoría / Marca / Proveedor / Subcategoría</span>
      </label>
    </div>`}
    <form id="prod-form" class="grid grid-cols-3 gap-3">
      <label class="col-span-3"><span class="text-xs font-black text-[#7d6c5c] uppercase">Nombre *</span>
        <input name="name" class="ing-input mt-1" required value="${p?.name || ''}" />
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
      <div class="col-span-3 grid grid-cols-2 gap-3 p-2 bg-[#fff1e6] rounded-xl border border-[#e3ceba]">
        <label><span class="text-xs font-black text-[#7d6c5c] uppercase">Stock ${lomas?.name || 'Lomas'}</span>
          <input name="stock_lomas" type="number" min="0" step="1" class="ing-input mt-1" value="${stockLomas}" />
        </label>
        <label><span class="text-xs font-black text-[#7d6c5c] uppercase">Stock ${banf?.name || 'Banfield'}</span>
          <input name="stock_banfield" type="number" min="0" step="1" class="ing-input mt-1" value="${stockBanf}" />
        </label>
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
            <input name="promotional_price" type="number" step="0.01" min="0" class="ing-input mt-1" value="${p?.promotional_price ?? ''}" placeholder="opcional" />
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
    onOpen: (el, close) => {
      const form = el.querySelector('#prod-form');
      // Live recompute de precio cuando cambia costo o %
      const costIn = form.elements.cost, pctIn = form.elements.margin_pct, priceIn = form.elements.price;
      const recalcPrice = () => priceIn.value = (Number(costIn.value) * (1 + Number(pctIn.value)/100)).toFixed(2);
      const recalcPct = () => { if (Number(costIn.value) > 0) pctIn.value = ((Number(priceIn.value)/Number(costIn.value)-1)*100).toFixed(2); };
      costIn.addEventListener('input', recalcPrice);
      pctIn.addEventListener('input', recalcPrice);
      priceIn.addEventListener('input', recalcPct);

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

          // Armamos el árbol agrupando por parent. Cada lista de hijos se ordena por nombre.
          // sortKey: trim + saca símbolos iniciales (+, –, *) así "+18" se ordena por "18".
          // Comparación con locale es-AR y numeric:true para que "3 a 5 años" < "12 a 17 años".
          const sortKey = (n) => String(n || '').trim().replace(/^[^\p{L}\p{N}]+/u, '').toLowerCase();
          const cmp = (a, b) => sortKey(a.name).localeCompare(sortKey(b.name), 'es', { numeric: true, sensitivity: 'base' });
          const byParent = new Map();
          for (const c of list) {
            const k = c.parent ?? null;
            if (!byParent.has(k)) byParent.set(k, []);
            byParent.get(k).push(c);
          }
          for (const arr of byParent.values()) arr.sort(cmp);

          // Render recursivo. Cada nodo tiene un chevron si tiene hijos.
          const renderNode = (c) => {
            const kids = byParent.get(c.id) || [];
            const hasKids = kids.length > 0;
            const nameLower = c.name.toLowerCase().replace(/"/g, '&quot;');
            return `
              <div class="cat-node" data-cat-name="${nameLower}">
                <div class="flex items-center gap-1 py-0.5 px-1 hover:bg-[#fff1e6] rounded">
                  ${hasKids
                    ? `<button type="button" class="chev w-5 h-5 inline-flex items-center justify-center text-[#7d6c5c] hover:text-[#d82f1e] font-bold" aria-expanded="false" title="Expandir">▸</button>`
                    : `<span class="w-5 inline-block"></span>`}
                  <label class="flex items-center gap-2 cursor-pointer flex-1">
                    <input type="checkbox" data-tn-cat="${c.id}" ${selectedTnCats.has(c.id) ? 'checked' : ''} class="rounded text-[#d82f1e] focus:ring-[#d82f1e]" />
                    <span>${escapeAttr(c.name)}</span>
                  </label>
                </div>
                ${hasKids ? `<div class="cat-children hidden ml-3 border-l border-[#e3ceba] pl-2">${kids.map(renderNode).join('')}</div>` : ''}
              </div>
            `;
          };
          const roots = byParent.get(null) || [];
          box.innerHTML = roots.map(renderNode).join('');

          // Toggle de chevrones (expandir/colapsar hijos).
          const toggleChev = (chev, force) => {
            const node = chev.closest('.cat-node');
            const children = node?.querySelector(':scope > .cat-children');
            if (!children) return;
            const willCollapse = force === undefined ? !children.classList.contains('hidden') : !force;
            children.classList.toggle('hidden', willCollapse);
            chev.setAttribute('aria-expanded', String(!willCollapse));
            chev.textContent = willCollapse ? '▸' : '▾';
            chev.title = willCollapse ? 'Expandir' : 'Colapsar';
          };
          box.querySelectorAll('.chev').forEach((chev) => {
            chev.addEventListener('click', (e) => {
              e.preventDefault();
              e.stopPropagation();
              toggleChev(chev);
            });
          });

          // Buscador: muestra nodos cuyo nombre matchea Y todos sus ancestros (para que se vean colgando).
          // Vacío → restaura colapsado por defecto.
          const searchInput = el.querySelector('#tn-cats-search');
          const applyFilter = (q) => {
            const allNodes = box.querySelectorAll('.cat-node');
            const allChevs = box.querySelectorAll('.chev');
            if (!q) {
              allNodes.forEach((n) => n.classList.remove('hidden'));
              box.querySelectorAll('.cat-children').forEach((c) => c.classList.add('hidden'));
              allChevs.forEach((chev) => {
                chev.setAttribute('aria-expanded', 'false');
                chev.textContent = '▸';
                chev.title = 'Expandir';
              });
              return;
            }
            const matches = new Set();
            allNodes.forEach((n) => {
              const name = n.dataset.catName || '';
              if (name.includes(q)) {
                matches.add(n);
                // Marcamos ancestros para que el match sea visible en su jerarquía.
                let p = n.parentElement;
                while (p && p !== box) {
                  if (p.classList.contains('cat-node')) matches.add(p);
                  p = p.parentElement;
                }
              }
            });
            allNodes.forEach((n) => n.classList.toggle('hidden', !matches.has(n)));
            // Expandimos todo para mostrar resultados profundos.
            box.querySelectorAll('.cat-children').forEach((c) => c.classList.remove('hidden'));
            allChevs.forEach((chev) => {
              chev.setAttribute('aria-expanded', 'true');
              chev.textContent = '▾';
              chev.title = 'Colapsar';
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
        const keepLbl = el.querySelector('#keep-fields-label');
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
          if (keepLbl) { keepLbl.classList.remove('hidden'); keepLbl.classList.add('flex'); }
        } else {
          single.classList.remove('hidden');
          single.classList.add('flex');
          bMode.classList.add('hidden');
          bMode.classList.remove('flex');
          panel.classList.add('hidden');
          if (keepLbl) { keepLbl.classList.add('hidden'); keepLbl.classList.remove('flex'); }
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
        const qtyLomas = Math.max(0, Number(d.stock_lomas) || 0);
        const qtyBanf  = Math.max(0, Number(d.stock_banfield) || 0);
        delete d.stock_lomas; delete d.stock_banfield;
        // Categorías TN seleccionadas (sólo importan si va a TN)
        const tnCatIds = Array.from(el.querySelectorAll('#tn-cats-box input[data-tn-cat]:checked'))
          .map((cb) => Number(cb.dataset.tnCat))
          .filter((n) => !Number.isNaN(n));
        d.tn_category_ids = tnCatIds;
        return { d, qtyLomas, qtyBanf };
      };

      const persistOne = async ({ d, qtyLomas, qtyBanf }) => {
        if (!d.name?.trim()) { toast('Nombre requerido', 'error'); return null; }
        const saved = await P.save({ ...(p || {}), ...d });
        const prevLomas = isEdit ? stockLomas : 0;
        const prevBanf  = isEdit ? stockBanf  : 0;
        if (qtyLomas !== prevLomas) {
          await P.adjustStock(saved.id, 'br_lomas', qtyLomas - prevLomas, isEdit ? 'Ajuste manual desde edición' : 'Stock inicial');
        }
        if (qtyBanf !== prevBanf) {
          await P.adjustStock(saved.id, 'br_banfield', qtyBanf - prevBanf, isEdit ? 'Ajuste manual desde edición' : 'Stock inicial');
        }
        if (d.published_tn) {
          try {
            const { api } = await import('../core/api.js');
            const baseBody = {
              id: saved.id, code: saved.code, name: saved.name,
              cost: Number(saved.cost) || 0,
              marginPct: Number(saved.margin_pct) || 0,
              price: Number(saved.price) || 0,
              publishedTn: true,
              // Campos extendidos para TN
              description: saved.description ?? null,
              promotionalPrice: saved.promotional_price ?? null,
              weight: saved.weight ?? null,
              width: saved.width ?? null,
              height: saved.height ?? null,
              depth: saved.depth ?? null,
              seoTitle: saved.seo_title ?? null,
              seoDescription: saved.seo_description ?? null,
              handle: saved.handle ?? null,
              videoUrl: saved.video_url ?? null,
              tnCategoryIds: saved.tn_category_ids ?? [],
            };
            const method = isEdit ? 'PUT' : 'POST';
            const path = isEdit ? `/api/products/${encodeURIComponent(saved.id)}` : '/api/products';
            const apiBody = method === 'POST'
              ? { ...baseBody, variants: [{ isDefault: true, stocks: [
                  { branchId: 'br_lomas', qty: qtyLomas },
                  { branchId: 'br_banfield', qty: qtyBanf },
                ] }] }
              : baseBody;
            const resp = await api(path, { method, body: apiBody });
            if (method === 'PUT') {
              const variantId = resp?.variants?.[0]?.id;
              if (variantId) {
                await api('/api/stock/set', { method: 'POST', body: { variantId, branchId: 'br_lomas',    qty: qtyLomas, reason: 'Ajuste desde inventario' } });
                await api('/api/stock/set', { method: 'POST', body: { variantId, branchId: 'br_banfield', qty: qtyBanf,  reason: 'Ajuste desde inventario' } });
              }
            }
            // Drenar imágenes pendientes (sólo aplica si estamos creando producto nuevo en
            // backend: en edición las imágenes ya se subieron al momento de pickearlas).
            if (pendingFiles.length > 0) {
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
            }
          } catch (e) {
            console.warn('push a TN falló', e);
            toast(`"${saved.name}" guardado local — sync TN pendiente`, 'warn');
          }
        }
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
        // Categorías TN: por defecto se mantienen entre productos del lote para que armar
        // un lote homogéneo sea rápido. (Si querés desmarcar, hacelo manualmente).
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
      el.querySelector('[data-act="save"]').addEventListener('click', async () => {
        const payload = readForm();
        const saved = await persistOne(payload);
        if (!saved) return;
        toast(isEdit ? 'Actualizado' : 'Creado', 'success');
        close(saved);
        renderProducts(container);
      });

      // Acciones modo "batch"
      if (!isEdit) {
        el.querySelector('[data-act="cancel-batch"]').addEventListener('click', () => {
          if (batch.length === 0) return close(null);
          confirmModal({ title: 'Cancelar lote', message: `Ya cargaste ${batch.length} producto(s). ¿Salir sin más cambios? (los ya cargados se mantienen)`, confirmLabel: 'Salir' })
            .then(ok => { if (ok) { close({ batch }); renderProducts(container); } });
        });
        el.querySelector('[data-act="save-and-continue"]').addEventListener('click', async () => {
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
        });
        el.querySelector('[data-act="finish-batch"]').addEventListener('click', async () => {
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
            }
          }
          if (batch.length === 0) { toast('No agregaste ningún producto', 'warn'); return; }
          toast(`Lote terminado: ${batch.length} producto(s) creado(s)`, 'success');
          close({ batch });
          renderProducts(container);
        });
      }
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
