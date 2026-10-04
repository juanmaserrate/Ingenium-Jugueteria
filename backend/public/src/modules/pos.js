// POS / Ventas — multi-pestaña, scan/búsqueda, descuentos %/fijo, edición de precio (doble-click),
// descuentos globales, pagos mixtos, clientes, vendedores, drafts.
// Confirma posteando a /api/sales (el backend hace stock + caja + auditoría atómicamente).
// De repos/sales.js solo usa cálculo de totales y persistencia de borradores.

import * as Sales from '../repos/sales.js';
import * as P from '../repos/products.js';
import * as Senas from '../repos/senas.js';
import * as Employees from '../repos/employees.js';
import * as Settings from '../repos/settings.js';
import { api, ApiError } from '../core/api.js';
import { Categories, Brands } from '../repos/catalog.js';
import { money, round2, fmtDateTime } from '../core/format.js';
import { openModal, confirmModal } from '../components/modal.js';
import { toast } from '../core/notifications.js';
import { activeBranchId, currentSession } from '../core/auth.js';
import { on, EV } from '../core/events.js';

// Candado anti doble-submit: evita que un doble click / F9 repetido dispare
// dos veces la confirmación de la MISMA venta (que crearía 2 ventas y doble
// descuento de stock). Se libera siempre en el finally de confirmSale.
let _confirming = false;

// ===== Estado global del POS =====
const state = {
  tabs: [],         // [{id, label, draftId, sale}]
  activeTab: null,  // id de la tab activa
  products: [],
  stocks: [],
  customers: [],
  employees: [],
  methods: [],
  categories: [],
  brands: [],
};

export async function mount(el) {
  await refreshData();
  // Reset tabs para no acumular entre re-mounts
  state.tabs = [];
  state.activeTab = null;
  // Cargar drafts existentes de la sesión (solo de la sucursal activa)
  const br = activeBranchId();
  const drafts = (await Sales.listDrafts()).filter(d => !d.branch_id || d.branch_id === br);
  if (drafts.length) {
    for (const d of drafts) state.tabs.push({ id: d.id, label: d.tab_label || `Venta`, draftId: d.id, sale: d });
    state.activeTab = state.tabs[0].id;
  } else {
    newTab();
  }
  render(el);

  // Reactividad: al tocar stock/producto actualizar datos
  // Las guardas evitan errores si el elemento ya no está en el DOM (el usuario cambió de módulo)
  const offStock = on(EV.STOCK_CHANGED, async () => {
    if (!el || !el.isConnected) { offStock(); return; }
    await refreshData();
    if (el.isConnected) renderCart(el);
  });
  const offProd = on(EV.PRODUCT_UPDATED, async () => {
    if (!el || !el.isConnected) { offProd(); return; }
    await refreshData();
    if (el.isConnected) renderCart(el);
  });

  // U-1: atajos de teclado para caja sin mouse
  const keyHandler = (ev) => {
    if (!el.isConnected) return;
    const focusSearch = () => { const s = el.querySelector('#pos-search'); if (s) { ev.preventDefault(); s.focus(); s.select?.(); } };
    const focusCustomer = () => { const s = el.querySelector('#pos-customer'); if (s) { ev.preventDefault(); s.focus(); } };
    const focusDiscount = () => { const s = el.querySelector('#pos-dpct'); if (s) { ev.preventDefault(); s.focus(); s.select?.(); } };
    const focusPay = () => { const b = el.querySelector('#pos-add-pay'); if (b) { ev.preventDefault(); b.click(); } };
    const doConfirm = () => { const b = el.querySelector('#pos-confirm'); if (b && !b.disabled) { ev.preventDefault(); b.click(); } };
    switch (ev.key) {
      case 'F1': focusSearch(); break;
      case 'F2': focusCustomer(); break;
      case 'F3': focusDiscount(); break;
      case 'F4': focusPay(); break;
      case 'F9': doConfirm(); break;
    }
    if (ev.ctrlKey && (ev.key === 't' || ev.key === 'T')) {
      ev.preventDefault();
      el.querySelector('#pos-new-tab')?.click();
    }
  };
  document.addEventListener('keydown', keyHandler);
  return () => { offStock(); offProd(); document.removeEventListener('keydown', keyHandler); };
}

async function refreshData() {
  const br = activeBranchId();
  // Datos online (única fuente de verdad). Si no hay conexión, dejamos listas vacías
  // y el POS avisa al intentar vender.
  let products = [], stocks = [], customers = [];
  state.offline = false;
  try {
    // Derivamos el stock de los productos ya traídos (cada uno trae _stocks) para evitar
    // una segunda lectura que podría devolver cache vieja por carrera.
    [products, customers] = await Promise.all([P.list(), api('/api/customers')]);
    stocks = products.flatMap(p => p._stocks || []);
  } catch (e) {
    if (e?.status === 0) {
      state.offline = true;
      toast('Sin conexión: se necesita internet para vender', 'error');
    } else {
      throw e;
    }
  }
  const [employees, methods, categories, brands] = await Promise.all([
    Employees.list().catch(() => []),
    Settings.getConfig('payment_methods', []),
    Categories.list().catch(() => []),
    Brands.list().catch(() => []),
  ]);
  state.products = products;
  state.stocks = stocks;
  state.customers = customers || [];
  state.employees = (employees || []).filter(e => e.active !== false && (!e.branchId || e.branchId === br));
  state.methods = methods || [];
  state.categories = categories;
  state.brands = brands;
}

// Descuento local del stock tras UNA venta propia, para NO recargar los ~11k productos
// del backend en cada venta (era el cuello de botella del POS). El servidor ya descontó
// el stock de forma atómica; acá solo reflejamos el cambio en memoria para la vista. Si
// algo quedara desfasado, el próximo refresh (STOCK_CHANGED externo o botón Actualizar)
// lo corrige, y la venta en el servidor siempre es la fuente de verdad.
function applyLocalStockDecrement(soldItems, br) {
  for (const it of soldItems || []) {
    const qty = Number(it.qty) || 0;
    if (!it.product_id || !qty) continue;
    const st = state.stocks.find(s => s.product_id === it.product_id && s.branch_id === br);
    if (st) st.qty = (Number(st.qty) || 0) - qty;
    // Mantener también el _stocks del producto cacheado (por si se relee desde ahí).
    const prod = state.products.find(p => p.id === it.product_id);
    const ps = prod?._stocks?.find(s => s.branch_id === br);
    if (ps) ps.qty = (Number(ps.qty) || 0) - qty;
  }
}

function newTab() {
  const existing = state.tabs.map(t => {
    const m = String(t.label).match(/^Venta\s+(\d+)$/);
    return m ? parseInt(m[1], 10) : 0;
  });
  const n = Math.max(0, ...existing) + 1;
  const id = `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  state.tabs.push({
    id,
    label: `Venta ${n}`,
    draftId: null,
    sale: emptySale(),
  });
  state.activeTab = id;
}

function emptySale() {
  return {
    items: [],
    payments: [],
    customer_id: null,
    seller_id: null,
    discount_global_pct: 0,
    discount_global_fixed: 0,
    surcharge_global_pct: 0,
    surcharge_global_fixed: 0,
    note: '',
  };
}

function activeTab() { return state.tabs.find(t => t.id === state.activeTab); }
function activeSale() { return activeTab()?.sale; }

// ===== Render principal =====
function render(el) {
  el.innerHTML = `
    <div class="mb-4 flex items-center justify-between gap-4">
      <div>
        <h1 class="text-3xl font-black text-[#241a0d]">Ventas</h1>
        <p class="text-sm text-[#7d6c5c] mt-1">Atajos: <kbd class="px-1 bg-[#fff1e6] rounded font-mono">F1</kbd> buscar · <kbd class="px-1 bg-[#fff1e6] rounded font-mono">F2</kbd> cliente · <kbd class="px-1 bg-[#fff1e6] rounded font-mono">F3</kbd> desc. · <kbd class="px-1 bg-[#fff1e6] rounded font-mono">F4</kbd> pago · <kbd class="px-1 bg-[#fff1e6] rounded font-mono">F9</kbd> confirmar · <kbd class="px-1 bg-[#fff1e6] rounded font-mono">Ctrl+T</kbd> nueva</p>
      </div>
      <div class="flex items-center gap-2">
        <button id="pos-new-tab" class="ing-btn-secondary flex items-center gap-2">
          <span class="material-symbols-outlined text-base">add</span> Nueva venta
        </button>
      </div>
    </div>

    <div id="pos-tabs" class="flex gap-1 mb-4 border-b border-[#fff1e6] overflow-x-auto"></div>

    <div class="grid grid-cols-[1fr_420px] gap-5">
      <div>
        <div class="ing-card p-4 mb-4">
          <div class="flex gap-2 items-stretch">
            <div class="relative flex-1">
              <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[#7d6c5c]">search</span>
              <input id="pos-search" type="text" placeholder="Buscá o escaneá (código, nombre)…" class="ing-input pl-10 w-full" autocomplete="off" />
            </div>
            <button id="pos-open-picker" class="ing-btn-secondary flex items-center gap-2">
              <span class="material-symbols-outlined">grid_view</span> Catálogo
            </button>
          </div>
          <div id="pos-search-results" class="mt-2"></div>
        </div>

        <div id="pos-cart"></div>
      </div>

      <div id="pos-side"></div>
    </div>
  `;

  el.querySelector('#pos-new-tab').addEventListener('click', async () => {
    newTab();
    await persistDraft();
    render(el);
  });
  renderTabs(el);
  renderCart(el);

  const search = el.querySelector('#pos-search');
  search.addEventListener('input', () => renderSearchResults(el));
  search.addEventListener('keydown', async (ev) => {
    if (ev.key === 'Enter') {
      const q = search.value.trim();
      if (!q) return;
      // Si hay match único por code → agregar directo (con selector de variante si corresponde)
      const match = state.products.filter(p => p.code?.toLowerCase() === q.toLowerCase() || p.barcode === q);
      if (match.length === 1) { pickAndAdd(match[0], el); return; }
      const first = el.querySelector('#pos-search-results [data-pid]');
      if (first) { const pid = first.dataset.pid; const p = state.products.find(x => x.id === pid); if (p) pickAndAdd(p, el); }
    }
  });
  el.querySelector('#pos-open-picker').addEventListener('click', () => openCatalogPicker(el));
  search.focus();
}

function renderTabs(root) {
  if (!root || !root.isConnected) return;
  const container = root.querySelector('#pos-tabs');
  if (!container) return;
  container.innerHTML = state.tabs.map(t => {
    const active = t.id === state.activeTab;
    const items = t.sale.items.length;
    return `
      <div class="relative group">
        <button data-tab="${t.id}" class="flex items-center gap-2 px-4 py-2.5 border-b-2 text-sm font-bold whitespace-nowrap transition-all
          ${active ? 'border-[#d82f1e] text-[#d82f1e] bg-white' : 'border-transparent text-[#7d6c5c] hover:text-[#d82f1e]'}">
          <span class="material-symbols-outlined text-base">shopping_cart</span>
          ${t.label}
          <span class="text-xs ${active ? 'bg-[#d82f1e] text-white' : 'bg-[#fff1e6] text-[#7d6c5c]'} px-1.5 py-0.5 rounded-full">${items}</span>
        </button>
        ${state.tabs.length > 1 ? `<button data-close="${t.id}" class="absolute -top-1 -right-1 opacity-0 group-hover:opacity-100 w-4 h-4 rounded-full bg-[#241a0d] text-white text-[10px] flex items-center justify-center">×</button>` : ''}
      </div>
    `;
  }).join('');
  container.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', async () => {
    state.activeTab = b.dataset.tab; renderTabs(root); renderCart(root);
  }));
  container.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    const id = b.dataset.close;
    const t = state.tabs.find(x => x.id === id);
    if (t?.sale.items.length) {
      const ok = await confirmModal({ title: 'Cerrar venta', message: '¿Descartar esta pestaña? Se perderán los items cargados.', danger: true, confirmLabel: 'Descartar' });
      if (!ok) return;
    }
    if (t?.draftId) await Sales.removeDraft(t.draftId).catch(() => {});
    state.tabs = state.tabs.filter(x => x.id !== id);
    if (state.activeTab === id) state.activeTab = state.tabs[0]?.id || null;
    if (!state.tabs.length) newTab();
    renderTabs(root); renderCart(root);
  }));
}

function renderSearchResults(root) {
  const q = root.querySelector('#pos-search').value.trim().toLowerCase();
  const box = root.querySelector('#pos-search-results');
  if (!q) { box.innerHTML = ''; return; }
  const results = state.products.filter(p =>
    p.name?.toLowerCase().includes(q) || p.code?.toLowerCase().includes(q) || (p.barcode || '').includes(q)
  ).slice(0, 8);
  if (!results.length) { box.innerHTML = `<div class="text-sm text-[#7d6c5c] p-2">Sin resultados</div>`; return; }
  const br = activeBranchId();
  box.innerHTML = `
    <div class="border border-[#fff1e6] rounded-xl overflow-hidden divide-y divide-[#fff1e6] bg-white">
      ${results.map(p => {
        const st = state.stocks.find(s => s.product_id === p.id && s.branch_id === br);
        const qty = st?.qty || 0;
        return `<button data-pid="${p.id}" class="w-full flex items-center justify-between gap-3 px-3 py-2 hover:bg-[#fff8f4] text-left">
          <div class="flex-1 min-w-0">
            <div class="font-bold text-sm text-[#241a0d] break-words leading-tight">${p.name}</div>
            <div class="text-xs text-[#7d6c5c] font-mono break-all">${p.code} · Stock: <span class="${qty <= 0 ? 'text-red-600 font-bold' : ''}">${qty}</span></div>
          </div>
          <div class="text-right">
            <div class="font-bold text-[#d82f1e] whitespace-nowrap">${money(p.price)}</div>
          </div>
        </button>`;
      }).join('')}
    </div>
  `;
  box.querySelectorAll('[data-pid]').forEach(b => b.addEventListener('click', () => {
    const p = state.products.find(x => x.id === b.dataset.pid);
    if (p) pickAndAdd(p, root);
  }));
}

// ===== Cart =====
// Si el producto tiene variantes, abre el selector; si no, agrega directo.
async function pickAndAdd(product, root) {
  if (product?.has_variants && (product.variants || []).length > 1) {
    const variant = await openVariantPicker(product);
    if (variant) addToCart(product, 1, variant);
  } else {
    addToCart(product);
  }
  if (root) { const s = root.querySelector('#pos-search'); if (s) s.value = ''; renderSearchResults(root); renderCart(root); }
}

// Modal para elegir la variante (talle/color) con su stock en la sucursal activa.
function openVariantPicker(product) {
  const br = activeBranchId();
  const variants = product.variants || [];
  return openModal({
    title: `Elegí variante · ${product.name}`,
    size: 'md',
    bodyHTML: `
      <div class="space-y-2">
        ${variants.map((v, i) => {
          const qty = v.stocks?.[br]?.qty ?? 0;
          const price = v.price_override ?? product.price;
          const label = Object.values(v.attributes || {})[0] || v.name || `Variante ${i + 1}`;
          return `<button data-vi="${i}" class="w-full flex items-center justify-between gap-3 px-3 py-2 border border-[#fff1e6] rounded-xl hover:border-[#d82f1e] text-left">
            <div><div class="font-bold text-sm">${escapeHtml(label)}</div><div class="text-xs text-[#7d6c5c]">Stock: <span class="${qty <= 0 ? 'text-red-600 font-bold' : ''}">${qty}</span></div></div>
            <div class="font-black text-[#d82f1e]">${money(price)}</div>
          </button>`;
        }).join('')}
      </div>`,
    footerHTML: `<button class="ing-btn-secondary" data-act="cancel">Cancelar</button>`,
    onOpen: (el, close) => {
      el.querySelectorAll('[data-vi]').forEach(b => b.addEventListener('click', () => close(variants[Number(b.dataset.vi)])));
      el.querySelector('[data-act="cancel"]').addEventListener('click', () => close(null));
    },
  });
}

function addToCart(product, qty = 1, variant = null) {
  const sale = activeSale();
  const variantId = variant?.id || product.variant_id || null;
  const ex = sale.items.find(it => it.product_id === product.id && it.variant_id === variantId && !it.manual);
  if (ex) { ex.qty = (Number(ex.qty) || 0) + qty; ex.subtotal = Sales.computeItemSubtotal(ex); }
  else {
    const vLabel = variant ? (Object.values(variant.attributes || {})[0] || variant.name) : null;
    const item = {
      product_id: product.id,
      variant_id: variantId,
      variant_name: vLabel,
      name: vLabel ? `${product.name} · ${vLabel}` : product.name,
      code: variant?.code || product.code,
      qty,
      unit_price: Number(variant?.price_override ?? product.price) || 0,
      discount_pct: 0,
      discount_fixed: 0,
      cost_snapshot: Number(variant?.cost_override ?? product.cost) || 0,
    };
    item.subtotal = Sales.computeItemSubtotal(item);
    sale.items.push(item);
  }
  persistDraft();
}

function renderCart(root) {
  if (!root || !root.isConnected) return;
  const container = root.querySelector('#pos-cart');
  if (!container) return;
  const tab = activeTab();
  if (!tab) return;
  const sale = tab.sale;
  const totals = Sales.computeTotals(sale);

  if (!sale.items.length) {
    container.innerHTML = `
      <div class="ing-card p-8 text-center">
        <span class="material-symbols-outlined text-6xl text-[#c9b6a4]">shopping_cart</span>
        <h3 class="font-black text-xl text-[#241a0d] mt-2">Carrito vacío</h3>
        <p class="text-sm text-[#7d6c5c]">Buscá un producto o escaneá un código para empezar.</p>
      </div>
    `;
  } else {
    container.innerHTML = `
      <div class="ing-card overflow-hidden">
        <div class="grid grid-cols-[48px_1fr_80px_110px_90px_110px_40px] gap-3 px-4 py-2 bg-[#fff8f4] text-xs font-bold text-[#7d6c5c] uppercase">
          <div>#</div><div>Producto</div><div class="text-center">Cant.</div><div class="text-right">Precio</div><div class="text-center">Dto %</div><div class="text-right">Subtotal</div><div></div>
        </div>
        <div class="divide-y divide-[#fff1e6]">
          ${sale.items.map((it, i) => cartRow(it, i)).join('')}
        </div>
      </div>
    `;
    container.querySelectorAll('[data-item-qty-plus]').forEach(b => b.addEventListener('click', () => { const i = Number(b.dataset.itemQtyPlus); sale.items[i].qty++; sale.items[i].subtotal = Sales.computeItemSubtotal(sale.items[i]); persistDraft(); renderCart(root); }));
    container.querySelectorAll('[data-item-qty-minus]').forEach(b => b.addEventListener('click', () => { const i = Number(b.dataset.itemQtyMinus); sale.items[i].qty = Math.max(1, (sale.items[i].qty || 1) - 1); sale.items[i].subtotal = Sales.computeItemSubtotal(sale.items[i]); persistDraft(); renderCart(root); }));
    container.querySelectorAll('[data-item-qty-input]').forEach(inp => inp.addEventListener('change', () => { const i = Number(inp.dataset.itemQtyInput); sale.items[i].qty = Math.max(1, Number(inp.value) || 1); sale.items[i].subtotal = Sales.computeItemSubtotal(sale.items[i]); persistDraft(); renderCart(root); }));
    container.querySelectorAll('[data-item-discount]').forEach(inp => inp.addEventListener('change', () => { const i = Number(inp.dataset.itemDiscount); sale.items[i].discount_pct = Math.min(100, Math.max(0, Number(inp.value) || 0)); sale.items[i].subtotal = Sales.computeItemSubtotal(sale.items[i]); persistDraft(); renderCart(root); }));
    container.querySelectorAll('[data-item-remove]').forEach(b => b.addEventListener('click', () => { const i = Number(b.dataset.itemRemove); sale.items.splice(i, 1); persistDraft(); renderCart(root); }));
    container.querySelectorAll('[data-item-edit-price]').forEach(el => el.addEventListener('dblclick', () => { const i = Number(el.dataset.itemEditPrice); editItemPrice(root, i); }));
  }

  renderSide(root, totals);
}

function cartRow(it, i) {
  return `
    <div class="grid grid-cols-[48px_1fr_80px_110px_90px_110px_40px] gap-3 px-4 py-2 items-center hover:bg-[#fff8f4]">
      <div class="text-xs font-bold text-[#7d6c5c]">${i + 1}</div>
      <div class="min-w-0">
        <div class="font-bold text-sm text-[#241a0d] break-words leading-tight">${it.name}</div>
        <div class="text-[10px] text-[#7d6c5c] font-mono break-all">${it.code || ''}</div>
      </div>
      <div class="flex items-center justify-center gap-1">
        <button data-item-qty-minus="${i}" class="w-6 h-6 rounded-md bg-[#fff1e6] text-[#7d6c5c] hover:bg-[#d82f1e] hover:text-white flex items-center justify-center font-bold">−</button>
        <input data-item-qty-input="${i}" type="number" min="1" value="${it.qty}" class="w-12 h-6 text-center border border-[#fff1e6] rounded-md text-sm font-bold" />
        <button data-item-qty-plus="${i}" class="w-6 h-6 rounded-md bg-[#fff1e6] text-[#7d6c5c] hover:bg-[#d82f1e] hover:text-white flex items-center justify-center font-bold">+</button>
      </div>
      <div data-item-edit-price="${i}" class="text-right font-bold text-sm text-[#241a0d] cursor-pointer hover:text-[#d82f1e]" title="Doble-click para editar">${money(it.unit_price)}</div>
      <div class="flex items-center justify-center">
        <input data-item-discount="${i}" type="number" min="0" max="100" value="${it.discount_pct || 0}" class="w-14 h-6 text-center border border-[#fff1e6] rounded-md text-xs" />
      </div>
      <div class="text-right font-bold text-sm text-[#d82f1e]">${money(it.subtotal || 0)}</div>
      <div>
        <button data-item-remove="${i}" class="w-7 h-7 rounded-md text-[#7d6c5c] hover:bg-red-50 hover:text-red-600 flex items-center justify-center">
          <span class="material-symbols-outlined text-base">delete</span>
        </button>
      </div>
    </div>
  `;
}

async function editItemPrice(root, i) {
  const sale = activeSale();
  const it = sale.items[i];
  await openModal({
    title: `Editar precio · ${it.name}`,
    size: 'sm',
    bodyHTML: `
      <label class="text-xs font-bold text-[#7d6c5c] uppercase">Precio unitario</label>
      <input id="epp" type="number" step="0.01" value="${it.unit_price}" class="ing-input w-full mt-1" />
      <p class="text-xs text-[#7d6c5c] mt-2">El precio original en catálogo no cambia.</p>
    `,
    footerHTML: `
      <button class="ing-btn-secondary" data-act="cancel">Cancelar</button>
      <button class="ing-btn-primary" data-act="ok">Aplicar</button>
    `,
    onOpen: (el, close) => {
      const inp = el.querySelector('#epp');
      inp.focus(); inp.select();
      const go = () => {
        const v = Math.max(0, Number(inp.value) || 0);
        it.unit_price = v;
        it.subtotal = Sales.computeItemSubtotal(it);
        persistDraft();
        close(true);
      };
      el.querySelector('[data-act="ok"]').addEventListener('click', go);
      el.querySelector('[data-act="cancel"]').addEventListener('click', () => close(false));
      inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go(); });
    },
  });
  renderCart(root);
}

// ===== Panel lateral: cliente, vendedor, totales, pagos =====
function renderSide(root, totals) {
  if (!root || !root.isConnected) return;
  const sale = activeSale();
  if (!sale) return;
  const side = root.querySelector('#pos-side');
  if (!side) return;
  const paid = round2((sale.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0));
  const pending = round2(totals.total - paid);

  side.innerHTML = `
    <div class="ing-card p-4 space-y-4 sticky top-4">
      <div>
        <div class="text-xs font-bold text-[#7d6c5c] uppercase mb-1">Cliente</div>
        <div id="pos-cust-box">${customerBoxHTML(sale)}</div>
      </div>

      <div>
        <div class="text-xs font-bold text-[#7d6c5c] uppercase mb-1">Vendedor</div>
        <select id="pos-seller" class="ing-input w-full">
          <option value="">— Sin vendedor —</option>
          ${state.employees.map(e => `<option value="${e.id}" ${sale.seller_id===e.id?'selected':''}>${e.name} ${e.lastname||''}</option>`).join('')}
        </select>
      </div>

      <div class="grid grid-cols-2 gap-2">
        <div>
          <div class="text-[10px] font-bold text-[#7d6c5c] uppercase">Dto global %</div>
          <input id="pos-dpct" type="number" min="0" max="100" value="${sale.discount_global_pct||0}" class="ing-input w-full" />
        </div>
        <div>
          <div class="text-[10px] font-bold text-[#7d6c5c] uppercase">Dto global $</div>
          <input id="pos-dfix" type="number" min="0" value="${sale.discount_global_fixed||0}" class="ing-input w-full" />
        </div>
        <div>
          <div class="text-[10px] font-bold text-[#7d6c5c] uppercase">Recargo %</div>
          <input id="pos-spct" type="number" min="0" value="${sale.surcharge_global_pct||0}" class="ing-input w-full" />
        </div>
        <div>
          <div class="text-[10px] font-bold text-[#7d6c5c] uppercase">Recargo $</div>
          <input id="pos-sfix" type="number" min="0" value="${sale.surcharge_global_fixed||0}" class="ing-input w-full" />
        </div>
      </div>

      <div class="bg-[#fff8f4] rounded-xl p-3 space-y-1 text-sm">
        <div class="flex justify-between"><span class="text-[#7d6c5c]">Subtotal items</span><span class="font-bold">${money(totals.items_subtotal)}</span></div>
        ${totals.discount_total > 0 ? `<div class="flex justify-between text-green-700"><span>Descuento</span><span>− ${money(totals.discount_total)}</span></div>` : ''}
        ${totals.surcharge_total > 0 ? `<div class="flex justify-between text-orange-700"><span>Recargo</span><span>+ ${money(totals.surcharge_total)}</span></div>` : ''}
        <div class="flex justify-between border-t border-[#fff1e6] pt-1 mt-1">
          <span class="font-black text-[#241a0d]">TOTAL</span>
          <span class="font-black text-xl text-[#d82f1e]">${money(totals.total)}</span>
        </div>
      </div>

      <div>
        <div class="flex items-center justify-between mb-1">
          <div class="text-xs font-bold text-[#7d6c5c] uppercase">Pagos</div>
          <button id="pos-add-pay" class="text-xs font-bold text-[#d82f1e] flex items-center gap-1"><span class="material-symbols-outlined text-sm">add</span> Agregar</button>
        </div>
        <div id="pos-pay-list" class="space-y-2">
          ${(sale.payments || []).map((p, i) => payRow(p, i)).join('')}
        </div>
        <div class="mt-2 text-xs flex justify-between ${Math.abs(pending) > 0.01 ? 'text-orange-600 font-bold' : 'text-green-700'}">
          <span>Pagado ${money(paid)}</span>
          <span>${pending > 0.01 ? `Falta ${money(pending)}` : pending < -0.01 ? `Vuelto ${money(-pending)}` : 'OK'}</span>
        </div>
      </div>

      <div class="flex gap-2">
        <button id="pos-fill-cash" class="flex-1 ing-btn-secondary text-sm">Pagar con efectivo</button>
        <button id="pos-use-vale" class="flex-1 ing-btn-secondary text-sm flex items-center justify-center gap-1"><span class="material-symbols-outlined text-base">local_activity</span> Usar vale</button>
      </div>

      <div class="space-y-2 pt-2 border-t border-[#fff1e6]">
        <button id="pos-confirm" class="w-full ing-btn-primary text-base py-3 flex items-center justify-center gap-2">
          <span class="material-symbols-outlined">check_circle</span> Confirmar venta
        </button>
        <button id="pos-save-draft" class="w-full ing-btn-secondary flex items-center justify-center gap-2">
          <span class="material-symbols-outlined text-base">save</span> Guardar borrador
        </button>
        <button id="pos-clear" class="w-full text-sm text-[#7d6c5c] hover:text-red-600">Vaciar carrito</button>
      </div>
    </div>
  `;

  wireCustomerBox(root, side, sale, totals);
  side.querySelector('#pos-seller').addEventListener('change', (ev) => { sale.seller_id = ev.target.value || null; persistDraft(); });
  ['dpct', 'dfix', 'spct', 'sfix'].forEach(k => {
    const map = { dpct: 'discount_global_pct', dfix: 'discount_global_fixed', spct: 'surcharge_global_pct', sfix: 'surcharge_global_fixed' };
    side.querySelector(`#pos-${k}`).addEventListener('change', (ev) => { sale[map[k]] = Math.max(0, Number(ev.target.value) || 0); persistDraft(); renderCart(root); });
  });
  side.querySelector('#pos-add-pay').addEventListener('click', () => {
    // Sin método por defecto: el cajero elige la forma de pago conscientemente.
    sale.payments.push({ method_id: '', amount: round2(Math.max(0, pending)) });
    persistDraft(); renderCart(root);
  });
  side.querySelectorAll('[data-pay-method]').forEach(s => s.addEventListener('change', (ev) => { const i = Number(s.dataset.payMethod); sale.payments[i].method_id = ev.target.value; persistDraft(); renderCart(root); }));
  side.querySelectorAll('[data-pay-amount]').forEach(inp => inp.addEventListener('change', (ev) => { const i = Number(inp.dataset.payAmount); sale.payments[i].amount = Math.max(0, Number(ev.target.value) || 0); persistDraft(); renderCart(root); }));
  side.querySelectorAll('[data-pay-remove]').forEach(b => b.addEventListener('click', () => { const i = Number(b.dataset.payRemove); sale.payments.splice(i, 1); persistDraft(); renderCart(root); }));
  side.querySelector('#pos-fill-cash').addEventListener('click', () => {
    sale.payments = [{ method_id: 'cash', amount: totals.total }];
    persistDraft(); renderCart(root);
  });
  side.querySelector('#pos-use-vale')?.addEventListener('click', () => applyVale(root, sale, totals));
  side.querySelector('#pos-save-draft').addEventListener('click', async () => { await persistDraft(); toast('Borrador guardado', 'success'); });
  side.querySelector('#pos-clear').addEventListener('click', async () => {
    const ok = await confirmModal({ title: 'Vaciar', message: '¿Vaciar el carrito actual?', danger: true, confirmLabel: 'Vaciar' });
    if (!ok) return;
    const t = activeTab();
    t.sale = emptySale();
    persistDraft(); renderCart(root);
  });
  side.querySelector('#pos-confirm').addEventListener('click', () => openCobroModal(root));
}

// ===== Modal de cobro (se abre al "Confirmar venta") =====
// Pregunta la(s) forma(s) de pago (permite mixto), sin efectivo por defecto, y recién
// al "Cobrar y confirmar" ejecuta la venta.
async function openCobroModal(root) {
  const sale = activeSale();
  if (!sale) return;
  if (!sale.items.length) { toast('El carrito está vacío', 'warn'); return; }
  const totals = Sales.computeTotals(sale);
  // Arrancar con una fila vacía (sin método) si no hay pagos cargados.
  if (!sale.payments.length) sale.payments = [{ method_id: '', amount: round2(totals.total) }];

  const bodyHTML = () => {
    const paid = round2((sale.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0));
    const pending = round2(totals.total - paid);
    const exact = Math.abs(pending) <= 0.01;
    const allChosen = sale.payments.length > 0 && !sale.payments.some(p => !p.method_id);
    const canConfirm = allChosen && exact;
    const estado = pending > 0.01
      ? `<span class="text-orange-600 font-bold">Falta ${money(pending)}</span>`
      : pending < -0.01
        ? `<span class="text-orange-600 font-bold">Se pasó ${money(-pending)} — ajustá los montos</span>`
        : `<span class="text-green-700 font-bold">Monto exacto ✓</span>`;
    return `
      <div class="space-y-4">
        <div class="bg-[#fff8f4] rounded-xl p-3 flex justify-between items-center">
          <span class="font-black text-[#241a0d]">TOTAL A COBRAR</span>
          <span class="font-black text-2xl text-[#d82f1e]">${money(totals.total)}</span>
        </div>
        <div>
          <div class="text-xs font-bold text-[#7d6c5c] uppercase mb-1">Pago rápido (un solo medio)</div>
          <div class="flex flex-wrap gap-2">
            ${state.methods.map(m => `<button type="button" data-quick="${m.id}" class="ing-btn-secondary text-sm !py-1.5 !px-3">${escapeHtml(m.name)}</button>`).join('')}
          </div>
        </div>
        <div>
          <div class="flex items-center justify-between mb-1">
            <div class="text-xs font-bold text-[#7d6c5c] uppercase">Formas de pago (podés combinar)</div>
            <button type="button" data-add class="text-xs font-bold text-[#d82f1e] flex items-center gap-1"><span class="material-symbols-outlined text-sm">add</span> Agregar</button>
          </div>
          <div class="space-y-2">${sale.payments.map((p, i) => payRow(p, i)).join('')}</div>
          <div class="mt-2 text-sm flex justify-between"><span class="text-[#7d6c5c]">Pagado ${money(paid)}</span>${estado}</div>
        </div>
        <button type="button" data-cobrar ${canConfirm ? '' : 'disabled'} class="w-full ing-btn-primary text-base py-3 flex items-center justify-center gap-2 ${canConfirm ? '' : 'opacity-50 cursor-not-allowed'}">
          <span class="material-symbols-outlined">check_circle</span> Cobrar y confirmar venta
        </button>
      </div>`;
  };

  await openModal({
    title: 'Cobro',
    size: 'sm',
    bodyHTML: `<div id="cobro-body">${bodyHTML()}</div>`,
    footerHTML: `<button class="ing-btn-secondary" data-act="cancel">Cancelar</button>`,
    onOpen: (el, close) => {
      const redraw = () => { el.querySelector('#cobro-body').innerHTML = bodyHTML(); wire(); };
      const wire = () => {
        el.querySelectorAll('[data-quick]').forEach(b => b.addEventListener('click', () => {
          // Preserva pagos fijos (vale/seña) y cubre el resto con el medio elegido.
          const fixed = sale.payments.filter(p => p.method_id === 'credit_note' || p.method_id === 'sena');
          const fixedPaid = round2(fixed.reduce((s, p) => s + (Number(p.amount) || 0), 0));
          const rest = round2(Math.max(0, totals.total - fixedPaid));
          sale.payments = [...fixed, ...(rest > 0 ? [{ method_id: b.dataset.quick, amount: rest }] : [])];
          persistDraft(); redraw();
        }));
        el.querySelector('[data-add]')?.addEventListener('click', () => {
          const paid = round2((sale.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0));
          sale.payments.push({ method_id: '', amount: round2(Math.max(0, totals.total - paid)) });
          persistDraft(); redraw();
        });
        el.querySelectorAll('[data-pay-method]').forEach(s => s.addEventListener('change', (ev) => { sale.payments[Number(s.dataset.payMethod)].method_id = ev.target.value; persistDraft(); redraw(); }));
        el.querySelectorAll('[data-pay-amount]').forEach(inp => inp.addEventListener('change', (ev) => { sale.payments[Number(inp.dataset.payAmount)].amount = Math.max(0, Number(ev.target.value) || 0); persistDraft(); redraw(); }));
        el.querySelectorAll('[data-pay-remove]').forEach(b => b.addEventListener('click', () => { sale.payments.splice(Number(b.dataset.payRemove), 1); persistDraft(); redraw(); }));
        el.querySelector('[data-cobrar]')?.addEventListener('click', async () => {
          close(true);
          await confirmSale(root);
        });
      };
      el.querySelector('[data-act="cancel"]').addEventListener('click', () => close(false));
      wire();
    },
  });
  // Al cerrar el modal (cobrar o cancelar) refrescamos el panel para reflejar los pagos.
  renderCart(root);
}

function payRow(p, i) {
  // Pago con VALE (nota de crédito): medio fijo, monto no editable.
  if (p.method_id === 'credit_note') {
    return `
    <div class="flex gap-2 items-center">
      <div class="ing-input flex-1 !bg-amber-50 !border-amber-200 text-amber-700 font-bold text-sm flex items-center">Vale ${escapeHtml(p.code || '')}</div>
      <div class="w-28 text-right font-bold text-sm text-amber-700">${money(p.amount || 0)}</div>
      <button data-pay-remove="${i}" title="Quitar vale" class="w-8 h-8 rounded-md text-[#7d6c5c] hover:bg-red-50 hover:text-red-600 flex items-center justify-center">
        <span class="material-symbols-outlined text-base">close</span>
      </button>
    </div>`;
  }
  // Pago con SEÑA: medio fijo, monto no editable (es el valor de la seña).
  if (p.method_id === 'sena') {
    return `
    <div class="flex gap-2 items-center">
      <div class="ing-input flex-1 !bg-indigo-50 !border-indigo-200 text-indigo-700 font-bold text-sm flex items-center">Seña #${p.sena_number}</div>
      <div class="w-28 text-right font-bold text-sm text-indigo-700">${money(p.amount || 0)}</div>
      <button data-pay-remove="${i}" title="Quitar seña" class="w-8 h-8 rounded-md text-[#7d6c5c] hover:bg-red-50 hover:text-red-600 flex items-center justify-center">
        <span class="material-symbols-outlined text-base">close</span>
      </button>
    </div>`;
  }
  return `
    <div class="flex gap-2 items-center">
      <select data-pay-method="${i}" class="ing-input flex-1">
        <option value="" disabled ${!p.method_id ? 'selected' : ''}>— Forma de pago —</option>
        ${state.methods.map(m => `<option value="${m.id}" ${p.method_id === m.id ? 'selected' : ''}>${m.name}${m.surcharge_pct ? ` (+${m.surcharge_pct}%)` : ''}</option>`).join('')}
      </select>
      <input data-pay-amount="${i}" type="number" step="0.01" min="0" value="${p.amount || 0}" class="ing-input w-28 text-right font-bold" />
      <button data-pay-remove="${i}" class="w-8 h-8 rounded-md text-[#7d6c5c] hover:bg-red-50 hover:text-red-600 flex items-center justify-center">
        <span class="material-symbols-outlined text-base">close</span>
      </button>
    </div>
  `;
}

// ===== Drafts =====
async function persistDraft() {
  const t = activeTab();
  if (!t) return;
  const session = currentSession();
  const record = {
    id: t.draftId || `draft_${t.id}`,
    tab_label: t.label,
    branch_id: activeBranchId(),
    user_id: session?.user_id || null,
    ...t.sale,
  };
  const saved = await Sales.saveDraft(record);
  t.draftId = saved.id;
}

// Mapea la venta que devuelve el backend (camelCase + snapshots) al shape que
// usan el recibo y el ticket del POS.
function saleToFront(bs) {
  return {
    id: bs.id,
    number: bs.number,
    datetime: bs.datetime,
    total: bs.total,
    items_subtotal: bs.itemsSubtotal,
    discount_total: bs.discountTotal,
    surcharge_total: bs.surchargeTotal,
    items: (bs.items || []).map(i => ({ name: i.productNameSnap, qty: i.qty, subtotal: i.subtotal })),
    payments: (bs.payments || []).map(p => ({ method_id: p.methodName || p.methodId, amount: p.amount })),
  };
}

// ===== Confirmar venta =====
async function confirmSale(root) {
  // Anti doble-submit: si ya hay una confirmación en curso, ignorar.
  if (_confirming) return;
  const btn = (root?.querySelector?.('#pos-confirm')) || document.getElementById('pos-confirm');
  const btnOrig = btn ? btn.innerHTML : null;
  _confirming = true;
  if (btn) {
    btn.disabled = true;
    btn.classList.add('opacity-60', 'cursor-not-allowed');
    btn.innerHTML = '<span class="material-symbols-outlined animate-spin">progress_activity</span> Procesando…';
  }
  try {
    await _confirmSaleInner(root);
  } finally {
    _confirming = false;
    // Si la venta salió OK el panel se re-renderiza y este botón queda
    // desconectado (hay uno nuevo, habilitado). Solo restauramos si sigue vivo
    // (caminos de validación/error que no re-renderizan).
    if (btn && btn.isConnected) {
      btn.disabled = false;
      btn.classList.remove('opacity-60', 'cursor-not-allowed');
      if (btnOrig != null) btn.innerHTML = btnOrig;
    }
  }
}

async function _confirmSaleInner(root) {
  const t = activeTab();
  const sale = t.sale;
  if (!sale.items.length) { toast('El carrito está vacío', 'warn'); return; }
  const totals = Sales.computeTotals(sale);
  const paid = (sale.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
  // Ya NO se asume efectivo: la forma de pago se elige en el modal de cobro.
  if (!sale.payments || !sale.payments.length) { toast('Agregá la forma de pago', 'warn'); return; }
  if (sale.payments.some(p => !p.method_id)) { toast('Elegí la forma de pago', 'warn'); return; }
  if (Math.abs(paid - totals.total) > 0.01) {
    toast(`Los pagos (${money(paid)}) no coinciden con el total (${money(totals.total)})`, 'error');
    return;
  }

  const br = activeBranchId();

  // Resolver variantId de cada item (los items viejos de drafts pueden no tenerlo).
  for (const it of sale.items) {
    if (!it.variant_id) {
      const p = state.products.find(x => x.id === it.product_id);
      it.variant_id = p?.variant_id || null;
    }
  }
  const missingVariant = sale.items.find(it => !it.variant_id);
  if (missingVariant) {
    toast(`"${missingVariant.name}" no está sincronizado con el servidor. Recargá el catálogo.`, 'error');
    return;
  }

  // Pre-check de stock en sucursal activa (best-effort — la validación atómica la
  // hace el backend en POST /api/sales; acá sólo confirmamos con el usuario).
  let allowNegative = false;
  for (const it of sale.items) {
    const st = state.stocks.find(s => s.product_id === it.product_id && s.branch_id === br);
    if (!st || st.qty < Number(it.qty)) {
      const ok = await confirmModal({
        title: 'Stock insuficiente',
        message: `"${it.name}" tiene stock ${st?.qty || 0} y pediste ${it.qty}. ¿Confirmás igual? (el stock puede quedar negativo)`,
        danger: true, confirmLabel: 'Confirmar igual',
      });
      if (!ok) return;
      allowNegative = true;
      break;
    }
  }

  // Id estable de ESTA venta: se manda como offlineId para idempotencia. Si por un
  // timeout se reintenta la misma venta, el backend (offlineId @unique) devuelve la
  // que ya creó en vez de duplicarla. Una venta nueva (carrito nuevo) genera otro id.
  if (!sale.client_sale_id) {
    sale.client_sale_id = (globalThis.crypto?.randomUUID?.()) || ('cs_' + Date.now() + '_' + Math.random().toString(36).slice(2));
  }
  const buildBody = (negative) => ({
    branchId: br,
    sellerId: null, // empleados aún no migrados al backend
    customerId: sale.customer_id || null,
    offlineId: sale.client_sale_id,
    items: sale.items.map(it => ({
      variantId: it.variant_id,
      qty: Number(it.qty),
      unitPrice: Number(it.unit_price),
      discountPct: it.discount_pct ? Number(it.discount_pct) : null,
      discountFixed: it.discount_fixed ? Number(it.discount_fixed) : null,
      priceOverridden: false,
    })),
    payments: (sale.payments || []).map(p => {
      // Pago con seña: no mueve caja (la plata entró al crearla) y lleva senaId.
      if (p.method_id === 'sena') {
        return { methodId: 'sena', methodName: `Seña #${p.sena_number}`, amount: Number(p.amount) || 0, affectsCash: false, senaId: p.sena_id };
      }
      // Pago con vale (nota de crédito): no mueve caja; lleva creditNoteId para canjearlo.
      if (p.method_id === 'credit_note') {
        return { methodId: 'credit_note', methodName: `Vale ${p.code || ''}`.trim(), amount: Number(p.amount) || 0, affectsCash: false, creditNoteId: p.credit_note_id };
      }
      const m = state.methods.find(x => x.id === p.method_id);
      return {
        methodId: p.method_id,
        methodName: m?.name || p.method_id,
        amount: Number(p.amount) || 0,
        // El backend usa esto para saber si el pago entra a la caja (efectivo).
        affectsCash: m ? !!m.affects_cash : (p.method_id === 'cash'),
      };
    }),
    discountGlobalPct: sale.discount_global_pct || null,
    discountGlobalFixed: sale.discount_global_fixed || null,
    surchargeGlobalPct: sale.surcharge_global_pct || null,
    surchargeGlobalFixed: sale.surcharge_global_fixed || null,
    source: 'pos',
    allowNegative: negative,
  });

  try {
    let bs;
    try {
      bs = await api('/api/sales', { method: 'POST', body: buildBody(allowNegative) });
    } catch (err) {
      // El backend valida stock atómicamente. Si falta stock, ofrecemos vender en negativo.
      if (err instanceof ApiError && err.status === 409 && err.code === 'STOCK_INSUFFICIENT') {
        const d = err.details || {};
        const ok = await confirmModal({
          title: 'Stock insuficiente en el servidor',
          message: `No alcanza el stock (disponible ${d.available ?? 0}, pediste ${d.requested ?? ''}). ¿Confirmás igual? El stock va a quedar en negativo.`,
          danger: true, confirmLabel: 'Confirmar igual',
        });
        if (!ok) { await refreshData(); renderCart(root); return; }
        bs = await api('/api/sales', { method: 'POST', body: buildBody(true) });
      } else if (err instanceof ApiError && err.status === 0) {
        toast('Sin conexión: se necesita internet para vender', 'error');
        return;
      } else {
        throw err;
      }
    }
    const rec = saleToFront(bs);
    // Snapshot de lo vendido ANTES de resetear el carrito, para el descuento local de stock.
    const soldItems = (sale.items || []).map(i => ({ product_id: i.product_id, qty: Number(i.qty) || 0 }));
    // Remover draft
    if (t.draftId) await Sales.removeDraft(t.draftId).catch(() => {});
    // Si es la única tab → reset, si hay otras → cerrar
    if (state.tabs.length === 1) {
      t.draftId = null;
      t.sale = emptySale();
      const n = Math.max(0, ...state.tabs.map(t => {
        const m = String(t.label).match(/^Venta\s+(\d+)$/); return m ? parseInt(m[1], 10) : 0;
      }));
      t.label = `Venta ${n + 1}`;
    } else {
      state.tabs = state.tabs.filter(x => x.id !== t.id);
      state.activeTab = state.tabs[0].id;
    }
    // Antes acá se hacía refreshData() (recargaba TODO el catálogo, ~11k productos, en
    // cada venta). Ahora solo descontamos localmente el stock de lo vendido.
    applyLocalStockDecrement(soldItems, br);
    state.senas = {}; // invalidar cache de señas (alguna pudo quedar usada)
    renderTabs(root); renderCart(root);
    showSaleReceipt(rec);
    // U-8: toast con deshacer durante 8s (reversión: stock + caja + audit).
    toast(`Venta #${rec.number} confirmada · ${money(rec.total)}`, 'success', {
      action: {
        label: 'Deshacer',
        timeoutMs: 8000,
        onClick: async () => {
          try {
            await api(`/api/sales/${encodeURIComponent(rec.id)}/cancel`, { method: 'POST', body: { reason: 'undo-toast' } });
            toast(`Venta #${rec.number} anulada`, 'info');
            await refreshData();
            renderCart(root);
          } catch (e) {
            toast('No se pudo anular: ' + e.message, 'error');
          }
        },
      },
    });
  } catch (err) {
    toast('Error: ' + err.message, 'error');
  }
}

async function showSaleReceipt(rec) {
  await openModal({
    title: `Venta #${rec.number} confirmada`,
    size: 'sm',
    bodyHTML: `
      <div class="text-center py-4">
        <span class="material-symbols-outlined text-6xl text-green-600">check_circle</span>
        <div class="mt-2 font-black text-2xl text-[#241a0d]">${money(rec.total)}</div>
        <div class="text-sm text-[#7d6c5c]">${rec.items.length} items · ${rec.payments.length} pago(s)</div>
      </div>
      <div class="bg-white border border-[#fff1e6] rounded-xl p-3 text-sm mb-2 max-h-52 overflow-y-auto">
        <div class="text-xs font-bold text-[#7d6c5c] uppercase tracking-wide mb-1">Detalle</div>
        ${(rec.items || []).map(it => `
          <div class="flex justify-between gap-2 py-0.5 border-b border-[#fff8f4] last:border-0">
            <span class="text-[#241a0d]"><span class="font-bold">${it.qty}×</span> ${escapeHtml(it.name)}</span>
            <span class="text-[#7d6c5c] whitespace-nowrap">${money(it.subtotal || 0)}</span>
          </div>`).join('')}
      </div>
      <div class="bg-[#fff8f4] rounded-xl p-3 text-sm space-y-1">
        <div class="flex justify-between"><span class="text-[#7d6c5c]">Subtotal items</span><span>${money(rec.items_subtotal || 0)}</span></div>
        ${rec.discount_total > 0 ? `<div class="flex justify-between text-green-700"><span>Descuento</span><span>− ${money(rec.discount_total)}</span></div>` : ''}
        ${rec.surcharge_total > 0 ? `<div class="flex justify-between text-orange-700"><span>Recargo</span><span>+ ${money(rec.surcharge_total)}</span></div>` : ''}
        <div class="flex justify-between font-bold text-[#d82f1e] border-t border-[#fff1e6] pt-1 mt-1"><span>Total</span><span>${money(rec.total)}</span></div>
      </div>
    `,
    footerHTML: `
      <button class="ing-btn-secondary flex items-center gap-2" data-act="print"><span class="material-symbols-outlined text-base">print</span> Imprimir</button>
      <button class="ing-btn-primary" data-act="ok">Listo</button>
    `,
    onOpen: (el, close) => {
      el.querySelector('[data-act="ok"]').addEventListener('click', () => close(true));
      el.querySelector('[data-act="print"]').addEventListener('click', () => printTicket(rec));
    },
  });
}

function printTicket(rec) {
  const w = window.open('', '_blank', 'width=360,height=640');
  if (!w) { toast('El navegador bloqueó la ventana de impresión', 'error'); return; }
  const rows = rec.items.map(it => `
    <tr>
      <td>${it.qty} × ${escapeHtml(it.name)}</td>
      <td style="text-align:right">${money(it.subtotal || 0)}</td>
    </tr>
  `).join('');
  const pays = (rec.payments || []).map(p => `<div class="pay"><span>${escapeHtml(p.method_id)}</span><span>${money(p.amount)}</span></div>`).join('');
  w.document.write(`<!DOCTYPE html>
<html lang="es-AR"><head><meta charset="utf-8"><title>Ticket ${rec.number}</title>
<style>
  * { box-sizing: border-box; }
  body { font: 12px/1.4 -apple-system, Segoe UI, sans-serif; padding: 12px; color: #111; }
  h1 { font-size: 16px; margin: 0 0 4px; letter-spacing: 1px; }
  .muted { color: #666; font-size: 11px; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0; }
  td { padding: 2px 0; vertical-align: top; }
  hr { border: 0; border-top: 1px dashed #999; margin: 8px 0; }
  .tot { font-weight: bold; font-size: 14px; display: flex; justify-content: space-between; }
  .pay { display: flex; justify-content: space-between; font-size: 11px; }
  @media print { @page { margin: 8mm; } }
</style></head>
<body>
  <h1>INGENIUM</h1>
  <div class="muted">Ticket N° ${String(rec.number).padStart(6, '0')}</div>
  <div class="muted">${new Date(rec.datetime).toLocaleString('es-AR')}</div>
  <hr>
  <table>${rows}</table>
  <hr>
  <div class="tot"><span>TOTAL</span><span>${money(rec.total)}</span></div>
  <hr>
  ${pays}
  <hr>
  <div class="muted" style="text-align:center">¡Gracias por su compra!</div>
  <script>window.onload = () => { window.print(); setTimeout(() => window.close(), 300); };<\/script>
</body></html>`);
  w.document.close();
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Aplica un VALE (nota de crédito) como medio de pago: pide el código, lo valida
// contra el backend (no usado, no vencido) y lo agrega por el monto pendiente
// (nunca más que el valor del vale → no genera vuelto en efectivo).
async function applyVale(root, sale, totals) {
  sale.payments = sale.payments || [];
  if (sale.payments.some(p => p.method_id === 'credit_note')) { toast('Ya hay un vale aplicado en esta venta', 'warn'); return; }
  const paid = sale.payments.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const pending = round2((totals.total || 0) - paid);
  if (pending <= 0.01) { toast('La venta ya está paga', 'warn'); return; }
  await openModal({
    title: 'Usar vale (nota de crédito)',
    size: 'sm',
    bodyHTML: `
      <label class="block text-xs font-bold text-[#7d6c5c] uppercase mb-1">Código del vale</label>
      <input id="vale-code" class="ing-input w-full" placeholder="Ej: NC-XXXXXX" autocomplete="off" />
      <div id="vale-msg" class="text-xs text-[#7d6c5c] mt-2">Falta pagar ${money(pending)}</div>`,
    footerHTML: `<button class="ing-btn-secondary" data-act="cancel">Cancelar</button><button class="ing-btn-primary" data-act="ok">Aplicar</button>`,
    onOpen: (el, close) => {
      setTimeout(() => el.querySelector('#vale-code')?.focus(), 50);
      const msg = el.querySelector('#vale-msg');
      const apply = async () => {
        const code = (el.querySelector('#vale-code').value || '').trim();
        if (!code) { msg.textContent = 'Ingresá un código'; return; }
        try {
          const cn = await api(`/api/credit-notes/lookup?code=${encodeURIComponent(code)}`);
          const amount = round2(Math.min(Number(cn.amount) || 0, pending));
          sale.payments.push({ method_id: 'credit_note', amount, credit_note_id: cn.id, code: cn.code });
          close(true);
          persistDraft(); renderCart(root);
          toast(`Vale ${cn.code} aplicado (${money(amount)})`, 'success');
        } catch (e) {
          msg.textContent = e.message || 'Vale inválido';
          msg.className = 'text-xs text-red-600 mt-2 font-bold';
        }
      };
      el.querySelector('[data-act="cancel"]').addEventListener('click', () => close(false));
      el.querySelector('[data-act="ok"]').addEventListener('click', apply);
      el.querySelector('#vale-code').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); apply(); } });
    },
  });
}

// ===== Cliente por número de documento =====
function currentCustomer(sale) {
  return sale.customer_id ? (state.customers.find(c => c.id === sale.customer_id) || null) : null;
}

function senaRowsHTML(sale, c) {
  state.senas = state.senas || {};
  const senas = state.senas[c.id];
  if (senas === undefined) return '<div class="text-[11px] text-[#7d6c5c] mt-1">Buscando señas…</div>';
  const appliedIds = new Set((sale.payments || []).filter(p => p.method_id === 'sena').map(p => p.sena_id));
  const avail = senas.filter(s => !appliedIds.has(s.id));
  if (!avail.length) return '';
  return `<div class="mt-2 space-y-1">
    <div class="text-[11px] font-bold text-indigo-700 uppercase">Tiene ${avail.length} seña(s)</div>
    ${avail.map(s => `<div class="flex items-center justify-between gap-2 bg-indigo-50 border border-indigo-200 rounded-lg px-2 py-1">
      <div class="text-xs min-w-0"><b class="text-indigo-700">Seña #${s.number}</b> · ${money(s.amount)}${s.note ? ' · ' + escapeHtml(s.note) : ''}</div>
      <button data-use-sena="${s.id}" class="text-xs font-bold text-indigo-700 hover:underline shrink-0">Usar</button>
    </div>`).join('')}
  </div>`;
}

function customerBoxHTML(sale) {
  const c = currentCustomer(sale);
  if (c) {
    return `<div class="flex items-center justify-between gap-2 bg-[#fff8f4] rounded-xl px-3 py-2">
      <div class="min-w-0">
        <div class="font-bold text-sm text-[#241a0d] break-words leading-tight">${escapeHtml(c.name)}${c.lastname ? ' ' + escapeHtml(c.lastname) : ''}</div>
        <div class="text-xs text-[#7d6c5c]">${c.documentNumber ? 'Doc ' + escapeHtml(c.documentNumber) : 'sin documento'}</div>
      </div>
      <div class="flex gap-1 shrink-0">
        <button id="cust-buys" title="Ver compras" class="ing-btn-secondary !px-2 !py-1"><span class="material-symbols-outlined text-base">receipt_long</span></button>
        <button id="cust-clear" title="Quitar" class="ing-btn-secondary !px-2 !py-1"><span class="material-symbols-outlined text-base">close</span></button>
      </div>
    </div>${senaRowsHTML(sale, c)}`;
  }
  return `<div class="flex gap-2">
      <input id="cust-doc" class="ing-input flex-1" placeholder="N° de documento…" inputmode="numeric" />
      <button id="cust-find" class="ing-btn-secondary !px-3">Buscar</button>
    </div>
    <div class="text-[11px] text-[#7d6c5c] mt-1">Consumidor final · buscá o creá el cliente por documento</div>`;
}

function wireCustomerBox(root, side, sale, totals) {
  const box = side.querySelector('#pos-cust-box');
  if (!box) return;
  const refresh = () => { box.innerHTML = customerBoxHTML(sale); wireCustomerBox(root, side, sale, totals); };
  const c = currentCustomer(sale);
  // Traer señas activas del cliente (una sola vez por cliente) y refrescar el box.
  state.senas = state.senas || {};
  if (c && state.senas[c.id] === undefined) {
    state.senas[c.id] = []; // marca "cargando" para no re-pedir
    Senas.list(c.id, 'active').then(list => { state.senas[c.id] = list || []; if (side.querySelector('#pos-cust-box')) refresh(); }).catch(() => { state.senas[c.id] = []; });
  }
  box.querySelectorAll('[data-use-sena]').forEach(b => b.addEventListener('click', () => {
    const senaId = b.dataset.useSena;
    const sena = (state.senas[c?.id] || []).find(s => s.id === senaId);
    if (!sena) return;
    sale.payments = sale.payments || [];
    sale.payments.push({ method_id: 'sena', amount: round2(sena.amount), sena_id: sena.id, sena_number: sena.number });
    persistDraft(); renderCart(root); // renderCart -> renderSide refresca todo (pagos + box + totales)
    toast(`Seña #${sena.number} aplicada (${money(sena.amount)})`, 'success');
  }));
  box.querySelector('#cust-clear')?.addEventListener('click', () => { sale.customer_id = null; persistDraft(); refresh(); });
  box.querySelector('#cust-buys')?.addEventListener('click', () => openCustomerPurchases(currentCustomer(sale)));
  const doc = box.querySelector('#cust-doc');
  const doFind = async () => {
    const v = (doc.value || '').trim();
    if (!v) { toast('Ingresá un número de documento', 'warn'); return; }
    try {
      const found = await api(`/api/customers/by-document/${encodeURIComponent(v)}`);
      if (found) {
        if (!state.customers.find(c => c.id === found.id)) state.customers.push(found);
        sale.customer_id = found.id; persistDraft(); refresh();
        toast(`Cliente: ${found.name}`, 'success');
      } else {
        openCreateCustomer(v, (created) => { state.customers.push(created); sale.customer_id = created.id; persistDraft(); refresh(); });
      }
    } catch (e) { toast('Error buscando: ' + (e.message || ''), 'error'); }
  };
  box.querySelector('#cust-find')?.addEventListener('click', doFind);
  doc?.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); doFind(); } });
}

async function openCreateCustomer(doc, onCreated) {
  await openModal({
    title: 'Nuevo cliente',
    size: 'sm',
    bodyHTML: `
      <label class="block text-xs font-bold text-[#7d6c5c] uppercase mb-1">Nombre y apellido *</label>
      <input id="nc-name" class="ing-input w-full mb-3" placeholder="Nombre" />
      <div class="grid grid-cols-3 gap-2 mb-3">
        <div class="col-span-1"><label class="block text-xs font-bold text-[#7d6c5c] uppercase mb-1">Tipo</label>
          <select id="nc-dtype" class="ing-input w-full"><option>DNI</option><option>CUIT</option><option>CUIL</option><option>Pasaporte</option></select></div>
        <div class="col-span-2"><label class="block text-xs font-bold text-[#7d6c5c] uppercase mb-1">Documento *</label>
          <input id="nc-doc" class="ing-input w-full" value="${escapeHtml(doc)}" /></div>
      </div>
      <label class="block text-xs font-bold text-[#7d6c5c] uppercase mb-1">Teléfono</label>
      <input id="nc-phone" class="ing-input w-full" placeholder="Opcional" />
    `,
    footerHTML: `<button class="ing-btn-secondary" data-act="cancel">Cancelar</button><button class="ing-btn-primary" data-act="ok">Crear cliente</button>`,
    onOpen: (el, close) => {
      setTimeout(() => el.querySelector('#nc-name')?.focus(), 50);
      el.querySelector('[data-act="cancel"]').addEventListener('click', () => close(false));
      el.querySelector('[data-act="ok"]').addEventListener('click', async () => {
        const name = el.querySelector('#nc-name').value.trim();
        const documentNumber = el.querySelector('#nc-doc').value.trim();
        const documentType = el.querySelector('#nc-dtype').value;
        const phone = el.querySelector('#nc-phone').value.trim() || null;
        if (!name) { toast('El nombre es obligatorio', 'warn'); return; }
        if (!documentNumber) { toast('El documento es obligatorio', 'warn'); return; }
        try {
          const created = await api('/api/customers', { method: 'POST', body: { name, documentNumber, documentType, phone } });
          close(true); toast('Cliente creado', 'success'); onCreated && onCreated(created);
        } catch (e) { toast('No se pudo crear: ' + (e.message || ''), 'error'); }
      });
    },
  });
}

async function openCustomerPurchases(cust) {
  if (!cust) return;
  await openModal({
    title: `Compras de ${cust.name}`,
    size: 'md',
    bodyHTML: `<div id="cp-list" class="text-sm text-[#7d6c5c]">Cargando…</div>`,
    footerHTML: `<button class="ing-btn-primary" data-act="ok">Cerrar</button>`,
    onOpen: async (el, close) => {
      el.querySelector('[data-act="ok"]').addEventListener('click', () => close(true));
      try {
        const sales = await api(`/api/customers/${encodeURIComponent(cust.id)}/sales`);
        const listEl = el.querySelector('#cp-list');
        if (!sales || !sales.length) { listEl.innerHTML = 'Sin compras registradas.'; return; }
        const total = sales.reduce((s, x) => s + (x.total || 0), 0);
        listEl.innerHTML = `
          <div class="mb-2 font-bold text-[#241a0d]">${sales.length} compra(s) · Total ${money(total)}</div>
          <div class="divide-y divide-[#fff1e6] max-h-80 overflow-y-auto">
          ${sales.map(s => `
            <div class="py-2">
              <div class="flex justify-between"><span class="font-bold text-[#241a0d]">#${String(s.number).padStart(6, '0')}</span><span class="font-black text-[#d82f1e]">${money(s.total)}</span></div>
              <div class="text-xs text-[#7d6c5c]">${fmtDateTime(s.datetime)}</div>
              <div class="text-xs text-[#241a0d] mt-1">${(s.items || []).map(it => `${it.qty}× ${escapeHtml(it.productNameSnap)}`).join(', ')}</div>
            </div>`).join('')}
          </div>`;
      } catch (e) { el.querySelector('#cp-list').innerHTML = 'Error: ' + escapeHtml(e.message || ''); }
    },
  });
}

// ===== Picker de catálogo (modal) =====
async function openCatalogPicker(root) {
  const sale = activeSale();
  const br = activeBranchId();
  let selCat = '', selBr = '', q = '';
  await openModal({
    title: 'Catálogo',
    size: 'xl',
    bodyHTML: `
      <div class="flex gap-2 mb-3">
        <input id="cp-q" placeholder="Buscar…" class="ing-input flex-1" />
        <select id="cp-cat" class="ing-input">
          <option value="">Todas categorías</option>
          ${state.categories.map(c => `<option value="${c.id}">${c.name}</option>`).join('')}
        </select>
        <select id="cp-br" class="ing-input">
          <option value="">Todas marcas</option>
          ${state.brands.map(b => `<option value="${b.id}">${b.name}</option>`).join('')}
        </select>
      </div>
      <div id="cp-grid" class="grid grid-cols-4 gap-3 max-h-[60vh] overflow-y-auto pr-2"></div>
    `,
    footerHTML: `<button class="ing-btn-secondary" data-act="close">Cerrar</button>`,
    onOpen: (el, close) => {
      const grid = el.querySelector('#cp-grid');
      const renderGrid = () => {
        const list = state.products.filter(p => {
          if (q && !(p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q))) return false;
          if (selCat && p.category_id !== selCat) return false;
          if (selBr && p.brand_id !== selBr) return false;
          return true;
        });
        grid.innerHTML = list.length ? list.map(p => {
          const st = state.stocks.find(s => s.product_id === p.id && s.branch_id === br);
          const qty = st?.qty || 0;
          return `<button data-pid="${p.id}" class="text-left border border-[#fff1e6] rounded-xl p-3 hover:border-[#d82f1e] transition-all">
            <div class="font-bold text-sm break-words leading-tight">${p.name}</div>
            <div class="text-xs text-[#7d6c5c] font-mono break-all">${p.code}</div>
            <div class="flex justify-between items-end mt-2">
              <div class="text-xs ${qty <= 0 ? 'text-red-600 font-bold' : 'text-[#7d6c5c]'}">Stock: ${qty}</div>
              <div class="font-black text-[#d82f1e]">${money(p.price)}</div>
            </div>
          </button>`;
        }).join('') : '<div class="col-span-4 text-center p-8 text-[#7d6c5c]">Sin resultados</div>';
        grid.querySelectorAll('[data-pid]').forEach(b => b.addEventListener('click', async () => {
          const p = state.products.find(x => x.id === b.dataset.pid);
          if (!p) return;
          if (p.has_variants && (p.variants || []).length > 1) {
            const variant = await openVariantPicker(p);
            if (variant) { addToCart(p, 1, variant); toast(`+1 ${p.name}`, 'info'); }
          } else { addToCart(p); toast(`+1 ${p.name}`, 'info'); }
        }));
      };
      el.querySelector('#cp-q').addEventListener('input', (ev) => { q = ev.target.value.trim().toLowerCase(); renderGrid(); });
      el.querySelector('#cp-cat').addEventListener('change', (ev) => { selCat = ev.target.value; renderGrid(); });
      el.querySelector('#cp-br').addEventListener('change', (ev) => { selBr = ev.target.value; renderGrid(); });
      el.querySelector('[data-act="close"]').addEventListener('click', () => close(null));
      renderGrid();
    },
  });
  renderCart(root);
}
