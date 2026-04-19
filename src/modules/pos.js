// POS / Ventas — multi-pestaña, scan/búsqueda, descuentos %/fijo, edición de precio (doble-click),
// descuentos globales, pagos mixtos, clientes, vendedores, drafts.
// Usa repos/sales.js para confirmar. Impacto en stock + caja + audit lo hace el repo.

import * as Sales from '../repos/sales.js';
import * as P from '../repos/products.js';
import { getAll, get } from '../core/db.js';
import { money, round2 } from '../core/format.js';
import { openModal, confirmModal } from '../components/modal.js';
import { toast } from '../core/notifications.js';
import { activeBranchId, currentSession } from '../core/auth.js';
import { on, EV } from '../core/events.js';

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
  const offStock = on(EV.STOCK_CHANGED, async () => { await refreshData(); renderCart(el); });
  const offProd = on(EV.PRODUCT_UPDATED, async () => { await refreshData(); renderCart(el); });

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
  const [products, stocks, customers, employees, methodsCfg, categories, brands] = await Promise.all([
    P.list(),
    getAll('stock'),
    getAll('customers'),
    getAll('employees'),
    get('config', 'payment_methods'),
    getAll('categories'),
    getAll('brands'),
  ]);
  const br = activeBranchId();
  state.products = products;
  state.stocks = stocks;
  state.customers = customers;
  state.employees = employees.filter(e => !e.branch_id || e.branch_id === br);
  state.methods = methodsCfg?.value || [];
  state.categories = categories;
  state.brands = brands;
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
      // Si hay match único por code → agregar directo
      const match = state.products.filter(p => p.code?.toLowerCase() === q.toLowerCase() || p.barcode === q);
      if (match.length === 1) { addToCart(match[0]); search.value = ''; renderSearchResults(el); renderCart(el); return; }
      const first = el.querySelector('#pos-search-results [data-pid]');
      if (first) { const pid = first.dataset.pid; const p = state.products.find(x => x.id === pid); if (p) { addToCart(p); search.value = ''; renderSearchResults(el); renderCart(el); } }
    }
  });
  el.querySelector('#pos-open-picker').addEventListener('click', () => openCatalogPicker(el));
  search.focus();
}

function renderTabs(root) {
  const container = root.querySelector('#pos-tabs');
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
            <div class="font-bold text-sm text-[#241a0d] truncate">${p.name}</div>
            <div class="text-xs text-[#7d6c5c] font-mono">${p.code} · Stock: <span class="${qty <= 0 ? 'text-red-600 font-bold' : ''}">${qty}</span></div>
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
    if (p) { addToCart(p); root.querySelector('#pos-search').value = ''; renderSearchResults(root); renderCart(root); }
  }));
}

// ===== Cart =====
function addToCart(product, qty = 1) {
  const sale = activeSale();
  const ex = sale.items.find(it => it.product_id === product.id && !it.manual);
  if (ex) { ex.qty = (Number(ex.qty) || 0) + qty; ex.subtotal = Sales.computeItemSubtotal(ex); }
  else {
    const item = {
      product_id: product.id,
      name: product.name,
      code: product.code,
      qty,
      unit_price: Number(product.price) || 0,
      discount_pct: 0,
      discount_fixed: 0,
      cost_snapshot: Number(product.cost) || 0,
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
        <div class="font-bold text-sm text-[#241a0d] truncate">${it.name}</div>
        <div class="text-[10px] text-[#7d6c5c] font-mono">${it.code || ''}</div>
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
  const sale = activeSale();
  const side = root.querySelector('#pos-side');
  const paid = (sale.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const pending = totals.total - paid;

  side.innerHTML = `
    <div class="ing-card p-4 space-y-4 sticky top-4">
      <div>
        <div class="text-xs font-bold text-[#7d6c5c] uppercase mb-1">Cliente</div>
        <div class="flex gap-2">
          <select id="pos-customer" class="ing-input flex-1">
            <option value="">— Consumidor final —</option>
            ${state.customers.map(c => `<option value="${c.id}" ${sale.customer_id===c.id?'selected':''}>${c.name}${c.lastname?' '+c.lastname:''}</option>`).join('')}
          </select>
        </div>
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

      <button id="pos-fill-cash" class="w-full ing-btn-secondary text-sm">Pagar todo con efectivo</button>

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

  side.querySelector('#pos-customer').addEventListener('change', (ev) => { sale.customer_id = ev.target.value || null; persistDraft(); });
  side.querySelector('#pos-seller').addEventListener('change', (ev) => { sale.seller_id = ev.target.value || null; persistDraft(); });
  ['dpct', 'dfix', 'spct', 'sfix'].forEach(k => {
    const map = { dpct: 'discount_global_pct', dfix: 'discount_global_fixed', spct: 'surcharge_global_pct', sfix: 'surcharge_global_fixed' };
    side.querySelector(`#pos-${k}`).addEventListener('change', (ev) => { sale[map[k]] = Math.max(0, Number(ev.target.value) || 0); persistDraft(); renderCart(root); });
  });
  side.querySelector('#pos-add-pay').addEventListener('click', () => {
    const defaultMethod = state.methods[0]?.id || 'cash';
    sale.payments.push({ method_id: defaultMethod, amount: round2(Math.max(0, pending)) });
    persistDraft(); renderCart(root);
  });
  side.querySelectorAll('[data-pay-method]').forEach(s => s.addEventListener('change', (ev) => { const i = Number(s.dataset.payMethod); sale.payments[i].method_id = ev.target.value; persistDraft(); renderCart(root); }));
  side.querySelectorAll('[data-pay-amount]').forEach(inp => inp.addEventListener('change', (ev) => { const i = Number(inp.dataset.payAmount); sale.payments[i].amount = Math.max(0, Number(ev.target.value) || 0); persistDraft(); renderCart(root); }));
  side.querySelectorAll('[data-pay-remove]').forEach(b => b.addEventListener('click', () => { const i = Number(b.dataset.payRemove); sale.payments.splice(i, 1); persistDraft(); renderCart(root); }));
  side.querySelector('#pos-fill-cash').addEventListener('click', () => {
    sale.payments = [{ method_id: 'cash', amount: totals.total }];
    persistDraft(); renderCart(root);
  });
  side.querySelector('#pos-save-draft').addEventListener('click', async () => { await persistDraft(); toast('Borrador guardado', 'success'); });
  side.querySelector('#pos-clear').addEventListener('click', async () => {
    const ok = await confirmModal({ title: 'Vaciar', message: '¿Vaciar el carrito actual?', danger: true, confirmLabel: 'Vaciar' });
    if (!ok) return;
    const t = activeTab();
    t.sale = emptySale();
    persistDraft(); renderCart(root);
  });
  side.querySelector('#pos-confirm').addEventListener('click', () => confirmSale(root));
}

function payRow(p, i) {
  return `
    <div class="flex gap-2 items-center">
      <select data-pay-method="${i}" class="ing-input flex-1">
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

// ===== Confirmar venta =====
async function confirmSale(root) {
  const t = activeTab();
  const sale = t.sale;
  if (!sale.items.length) { toast('El carrito está vacío', 'warn'); return; }
  const totals = Sales.computeTotals(sale);
  const paid = (sale.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
  if (Math.abs(paid - totals.total) > 0.01) {
    // Si no cargó pagos, asumir efvo
    if (!sale.payments.length) {
      sale.payments = [{ method_id: 'cash', amount: totals.total }];
    } else {
      toast(`Los pagos (${money(paid)}) no coinciden con el total (${money(totals.total)})`, 'error');
      return;
    }
  }

  // Pre-check de stock en sucursal activa (best-effort — la verificación atómica
  // ocurre dentro de Sales.confirm, por si otra pestaña vendió el mismo producto).
  const br = activeBranchId();
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

  try {
    const session = currentSession();
    let rec;
    try {
      rec = await Sales.confirm(sale, { userId: session.user_id, branchId: br, allowNegative });
    } catch (err) {
      // Race condition: otra pestaña vendió el mismo producto entre el pre-check y el confirm.
      if (err instanceof Sales.StockInsufficientError) {
        const list = err.items.map(i => `• ${i.name}: tenías ${i.available}, pediste ${i.needed}`).join('\n');
        const ok = await confirmModal({
          title: 'Stock cambió mientras confirmabas',
          message: `${list}\n\n¿Confirmás igual? El stock va a quedar en negativo.`,
          danger: true, confirmLabel: 'Confirmar igual',
        });
        if (!ok) { await refreshData(); renderCart(root); return; }
        rec = await Sales.confirm(sale, { userId: session.user_id, branchId: br, allowNegative: true });
      } else {
        throw err;
      }
    }
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
    await refreshData();
    renderTabs(root); renderCart(root);
    showSaleReceipt(rec);
    // U-8: toast con deshacer durante 8s (reversión: stock + caja + audit).
    toast(`Venta #${rec.number} confirmada · ${money(rec.total)}`, 'success', {
      action: {
        label: 'Deshacer',
        timeoutMs: 8000,
        onClick: async () => {
          try {
            await Sales.cancelSale(rec.id, { userId: currentSession()?.user_id, reason: 'undo-toast' });
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
            <div class="font-bold text-sm truncate">${p.name}</div>
            <div class="text-xs text-[#7d6c5c] font-mono">${p.code}</div>
            <div class="flex justify-between items-end mt-2">
              <div class="text-xs ${qty <= 0 ? 'text-red-600 font-bold' : 'text-[#7d6c5c]'}">Stock: ${qty}</div>
              <div class="font-black text-[#d82f1e]">${money(p.price)}</div>
            </div>
          </button>`;
        }).join('') : '<div class="col-span-4 text-center p-8 text-[#7d6c5c]">Sin resultados</div>';
        grid.querySelectorAll('[data-pid]').forEach(b => b.addEventListener('click', () => {
          const p = state.products.find(x => x.id === b.dataset.pid);
          if (p) { addToCart(p); toast(`+1 ${p.name}`, 'info'); }
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
