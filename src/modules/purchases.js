// Módulo Compras — backend-first (consume /api/purchases).
// Flujo: cargar factura → preview editable de items (costo, margen, precio,
// reparto de stock Lomas/Banfield, código de barras) → registrar (A/X + proveedor)
// → recibir (impacta stock + crea/actualiza productos + publica en TN).

import { api, ApiError, uploadFile } from '../core/api.js';
import { money, round2 } from '../core/format.js';
import { toast } from '../core/notifications.js';
import { confirmModal } from '../components/modal.js';
import { openTnProductModal } from '../components/tn-product-form.js';
import { Suppliers } from '../repos/catalog.js';
import { activeBranchId } from '../core/auth.js';

const state = {
  view: 'list',      // 'list' | 'editor'
  purchase: null,    // compra en edición (objeto del backend)
  branches: [],
  suppliers: [],
  rows: [],          // filas del preview (en memoria, se persisten con Guardar)
};

const STATUS_LABEL = {
  draft: 'Borrador', pending: 'Pendiente', received: 'Recibida', cancelled: 'Cancelada',
};
const STATUS_CLASS = {
  draft: 'bg-gray-100 text-gray-700',
  pending: 'bg-amber-100 text-amber-800',
  received: 'bg-green-100 text-green-800',
  cancelled: 'bg-red-100 text-red-700',
};

export async function mount(el) {
  state.view = 'list';
  state.purchase = null;
  try {
    const [branches, suppliers] = await Promise.all([
      api('/auth/branches').catch(() => []),
      Suppliers.list().catch(() => []),
    ]);
    state.branches = branches || [];
    state.suppliers = suppliers || [];
  } catch { /* noop */ }
  render(el);
}

function render(el) {
  if (state.view === 'editor') return renderEditor(el);
  renderList(el);
}

// ==================== LISTA ====================
async function renderList(el) {
  el.innerHTML = `
    <div class="mb-6 flex justify-between items-center">
      <div>
        <h1 class="text-3xl font-black text-[#241a0d]">Compras</h1>
        <p class="text-sm text-[#7d6c5c] mt-1">Facturas de proveedores, ingreso de mercadería y % de éxito</p>
      </div>
      <button id="btn-new" class="ing-btn-primary text-sm">
        <span class="material-symbols-outlined align-middle text-base">add</span> Nueva compra
      </button>
    </div>
    <div id="purchases-list" class="ing-card overflow-auto">
      <div class="text-center py-8 text-[#7d6c5c]">Cargando...</div>
    </div>
  `;
  el.querySelector('#btn-new').addEventListener('click', () => openEditor(el, null));
  await refreshList(el);
}

async function refreshList(el) {
  const listEl = el.querySelector('#purchases-list');
  if (!listEl) return;
  let purchases;
  try {
    purchases = await api('/api/purchases');
  } catch (err) {
    if (err instanceof ApiError && err.status === 0) {
      listEl.innerHTML = '<div class="text-center py-8 text-red-700">Backend offline</div>';
    } else {
      listEl.innerHTML = `<div class="text-center py-8 text-red-700">${err.message}</div>`;
    }
    return;
  }
  if (!purchases.length) {
    listEl.innerHTML = `<div class="text-center py-12 text-[#7d6c5c]">
      <span class="material-symbols-outlined text-5xl">shopping_cart</span>
      <p class="mt-2">No hay compras todavía</p>
    </div>`;
    return;
  }
  listEl.innerHTML = `
    <table class="ing-table w-full text-sm">
      <thead><tr>
        <th>#</th><th>Proveedor</th><th>Fecha</th><th>Factura</th>
        <th class="text-center">Items</th><th class="text-right">Total</th>
        <th class="text-center">Estado</th><th class="text-center">Éxito</th><th></th>
      </tr></thead>
      <tbody>
        ${purchases.map((p) => `
          <tr data-id="${p.id}" class="group cursor-pointer hover:bg-[#fff1e6]">
            <td class="font-mono font-bold text-[#d82f1e]">#${p.number}</td>
            <td>${p.supplier?.name || '<span class="text-[#7d6c5c]">—</span>'}</td>
            <td class="text-xs">${new Date(p.createdAt).toLocaleDateString('es-AR')}</td>
            <td><span class="font-bold">${p.invoiceType}</span> ${p.invoiceNumber || ''}</td>
            <td class="text-center">${p._count?.items ?? p.itemsCount ?? 0}</td>
            <td class="text-right font-bold">${money(p.totalCost)}</td>
            <td class="text-center"><span class="px-2 py-0.5 rounded-full text-xs font-bold ${STATUS_CLASS[p.status] || ''}">${STATUS_LABEL[p.status] || p.status}</span></td>
            <td class="text-center" data-success="${p.id}">${p.status === 'received' ? '<span class="text-[#7d6c5c] text-xs">…</span>' : '<span class="text-[#7d6c5c]">—</span>'}</td>
            <td class="text-right"><span class="material-symbols-outlined text-base text-[#7d6c5c] opacity-0 group-hover:opacity-100">chevron_right</span></td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  listEl.querySelectorAll('tr[data-id]').forEach((tr) => {
    tr.addEventListener('click', () => openEditor(el, tr.dataset.id));
  });

  // Carga lazy del % de éxito (unidades) por cada compra recibida.
  for (const p of purchases.filter((x) => x.status === 'received')) {
    const cell = listEl.querySelector(`[data-success="${p.id}"]`);
    if (!cell) continue;
    api(`/api/purchases/${encodeURIComponent(p.id)}/success`)
      .then((s) => {
        const u = s.totals.unitsPct;
        const color = u >= 70 ? 'bg-green-100 text-green-800' : u >= 30 ? 'bg-amber-100 text-amber-800' : 'bg-red-100 text-red-700';
        cell.innerHTML = `<span class="px-2 py-0.5 rounded-full text-xs font-bold ${color}" title="${s.totals.sold}/${s.totals.ordered} unidades · ${s.totals.moneyPct}% dinero">${u}%</span>`;
      })
      .catch(() => { cell.innerHTML = '<span class="text-[#7d6c5c]">—</span>'; });
  }
}

// ==================== EDITOR ====================
async function openEditor(el, purchaseId) {
  if (purchaseId) {
    try {
      state.purchase = await api(`/api/purchases/${encodeURIComponent(purchaseId)}`);
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    state.rows = state.purchase.items.map(itemToRow);
  } else {
    // Borrador nuevo en memoria; se crea en backend al guardar.
    state.purchase = {
      id: null,
      number: null,
      status: 'draft',
      branchId: activeBranchId() || state.branches[0]?.id || 'br_lomas',
      supplierId: null,
      invoiceType: 'A',
      invoiceNumber: '',
      marginPctDefault: 100,
      notes: '',
      documents: [],
    };
    state.rows = [];
  }
  state.view = 'editor';
  render(el);
}

function itemToRow(it) {
  return {
    id: it.id,
    variantId: it.variantId || null,
    productId: it.productId || null,
    matchType: it.matchType || 'unmatched',
    rawName: it.rawName || '',
    barcode: it.barcode || '',
    sku: it.sku || '',
    qtyOrdered: it.qtyOrdered || 0,
    unitCost: it.unitCost || 0,
    marginPct: it.marginPct ?? 100,
    salePrice: it.salePrice || 0,
    qtyLomas: it.qtyLomas || 0,
    qtyBanfield: it.qtyBanfield || 0,
    tnConfig: it.tnConfig || null,
    publishTn: !!it.publishTn,
  };
}

function newRow(marginPct) {
  return {
    id: null, variantId: null, productId: null, matchType: 'new',
    rawName: '', barcode: '', sku: '', qtyOrdered: 1, unitCost: 0,
    marginPct: marginPct ?? 100, salePrice: 0, qtyLomas: 0, qtyBanfield: 0,
    tnConfig: null, publishTn: false,
  };
}

function renderEditor(el) {
  const p = state.purchase;
  const readonly = p.status === 'received' || p.status === 'cancelled';
  const lomasName = state.branches.find((b) => b.id === 'br_lomas')?.name || 'Lomas';
  const banfName = state.branches.find((b) => b.id === 'br_banfield')?.name || 'Banfield';

  el.innerHTML = `
    <div class="mb-4 flex items-center gap-3">
      <button id="btn-back" class="p-2 hover:bg-[#fff1e6] rounded-full"><span class="material-symbols-outlined">arrow_back</span></button>
      <div>
        <h1 class="text-2xl font-black text-[#241a0d]">${p.number ? `Compra #${p.number}` : 'Nueva compra'}</h1>
        <span class="px-2 py-0.5 rounded-full text-xs font-bold ${STATUS_CLASS[p.status] || ''}">${STATUS_LABEL[p.status] || p.status}</span>
      </div>
    </div>

    <!-- Header -->
    <div class="ing-card mb-4 grid grid-cols-2 md:grid-cols-5 gap-3">
      <label><span class="text-xs font-black text-[#7d6c5c] uppercase">Proveedor</span>
        <select id="h-supplier" class="ing-input mt-1" ${readonly ? 'disabled' : ''}>
          <option value="">— Sin proveedor —</option>
          ${state.suppliers.map((s) => `<option value="${s.id}" ${p.supplierId === s.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
        </select>
      </label>
      <label><span class="text-xs font-black text-[#7d6c5c] uppercase">Tipo factura</span>
        <select id="h-invoice-type" class="ing-input mt-1" ${readonly ? 'disabled' : ''}>
          <option value="A" ${p.invoiceType === 'A' ? 'selected' : ''}>A</option>
          <option value="X" ${p.invoiceType === 'X' ? 'selected' : ''}>X</option>
        </select>
      </label>
      <label><span class="text-xs font-black text-[#7d6c5c] uppercase">N° factura</span>
        <input id="h-invoice-number" class="ing-input mt-1" value="${escapeHtml(p.invoiceNumber || '')}" ${readonly ? 'disabled' : ''} />
      </label>
      <label><span class="text-xs font-black text-[#7d6c5c] uppercase">Sucursal</span>
        <select id="h-branch" class="ing-input mt-1" ${readonly ? 'disabled' : ''}>
          ${state.branches.map((b) => `<option value="${b.id}" ${p.branchId === b.id ? 'selected' : ''}>${escapeHtml(b.name)}</option>`).join('')}
        </select>
      </label>
      <label><span class="text-xs font-black text-[#7d6c5c] uppercase">Margen global %</span>
        <input id="h-margin" type="number" step="0.01" class="ing-input mt-1" value="${p.marginPctDefault ?? 100}" ${readonly ? 'disabled' : ''} />
      </label>
    </div>

    ${readonly ? '' : `
    <!-- Factura adjunta + controles globales -->
    <div class="ing-card mb-4 flex flex-wrap items-center gap-3">
      <label class="inline-flex items-center gap-2 cursor-pointer px-3 py-2 bg-white border border-[#e3ceba] rounded-xl hover:bg-[#fff1e6]">
        <input type="file" id="doc-input" accept="application/pdf,image/png,image/jpeg,image/webp" class="hidden" />
        <span class="material-symbols-outlined text-base">attach_file</span>
        <span class="text-sm font-bold">Adjuntar factura</span>
      </label>
      <button id="btn-scan" class="ing-btn-secondary text-sm ${(p.documents || []).length ? '' : 'opacity-50 pointer-events-none'}">
        <span class="material-symbols-outlined align-middle text-base">auto_awesome</span> Escanear con IA
      </button>
      <span id="doc-status" class="text-xs text-[#7d6c5c]">${(p.documents || []).length} adjunto(s)</span>
      <div class="flex-1"></div>
      <button id="btn-apply-margin" class="ing-btn-secondary text-xs">Aplicar margen a todas</button>
      <button id="btn-round-10" class="ing-btn-secondary text-xs">Redondear a $10</button>
      <button id="btn-round-100" class="ing-btn-secondary text-xs">Redondear a $100</button>
      <button id="btn-split" class="ing-btn-secondary text-xs">Repartir stock</button>
      <button id="btn-add-row" class="ing-btn-primary text-xs"><span class="material-symbols-outlined align-middle text-sm">add</span> Fila</button>
    </div>`}

    <!-- Tabla de items -->
    <div class="ing-card overflow-auto">
      <table class="ing-table w-full text-sm" id="items-table">
        <thead><tr>
          <th>Producto</th>
          <th>Código de barras</th>
          <th>SKU</th>
          <th class="text-center">Cant.</th>
          <th class="text-right">Costo</th>
          <th class="text-right">% Marg.</th>
          <th class="text-right">Precio</th>
          <th class="text-center">${escapeHtml(lomasName)}</th>
          <th class="text-center">${escapeHtml(banfName)}</th>
          <th class="text-center">Match</th>
          <th class="text-center">TN</th>
          ${readonly ? '' : '<th></th>'}
        </tr></thead>
        <tbody id="items-body"></tbody>
      </table>
      <p class="text-xs text-[#7d6c5c] p-3" id="items-empty"></p>
    </div>

    ${p.status === 'received' ? `
    <div class="ing-card mt-4" id="success-panel">
      <div class="flex items-center gap-2 mb-3">
        <span class="material-symbols-outlined text-[#d82f1e]">trending_up</span>
        <h3 class="font-black text-[#241a0d]">Éxito de la compra</h3>
        <span class="material-symbols-outlined text-base text-[#7d6c5c] cursor-help" title="Estimación. Si compraste el mismo producto en varias compras, los períodos de venta pueden solaparse.">info</span>
      </div>
      <div id="success-body" class="text-sm text-[#7d6c5c]">Calculando...</div>
    </div>` : ''}

    <!-- Footer acciones -->
    <div class="mt-4 flex justify-end gap-3">
      ${readonly ? `<div class="text-sm text-[#7d6c5c] self-center">Compra ${STATUS_LABEL[p.status]?.toLowerCase()} — solo lectura</div>` : `
        <button id="btn-save" class="ing-btn-secondary">Guardar borrador</button>
        ${p.status === 'draft' ? '<button id="btn-pending" class="ing-btn-secondary">Marcar pendiente</button>' : ''}
        ${p.status === 'pending' ? '<button id="btn-receive" class="ing-btn-primary">Recibir mercadería</button>' : ''}
      `}
    </div>
  `;

  el.querySelector('#btn-back').addEventListener('click', () => { state.view = 'list'; render(el); });
  if (!readonly) wireEditorControls(el);
  renderRows(el);
  if (p.status === 'received') loadSuccessPanel(el);
}

const bar = (pct, color) => {
  const w = Math.min(100, Math.max(0, pct || 0));
  return `<div class="h-2.5 rounded-full bg-gray-100 overflow-hidden"><div class="h-full ${color}" style="width:${w}%"></div></div>`;
};

async function loadSuccessPanel(el) {
  const body = el.querySelector('#success-body');
  if (!body) return;
  let s;
  try {
    s = await api(`/api/purchases/${encodeURIComponent(state.purchase.id)}/success`);
  } catch (err) {
    body.innerHTML = `<span class="text-red-700">${err.message}</span>`;
    return;
  }
  const t = s.totals;
  body.innerHTML = `
    <div class="grid grid-cols-2 gap-6 mb-4">
      <div>
        <div class="flex justify-between text-xs font-bold mb-1"><span>Unidades vendidas</span><span>${t.sold}/${t.ordered} · ${t.unitsPct}%</span></div>
        ${bar(t.unitsPct, 'bg-[#d82f1e]')}
      </div>
      <div>
        <div class="flex justify-between text-xs font-bold mb-1"><span>Dinero recuperado</span><span>${money(t.recovered)} / ${money(t.invested)} · ${t.moneyPct}%</span></div>
        ${bar(t.moneyPct, 'bg-green-600')}
      </div>
    </div>
    <table class="w-full text-xs">
      <thead><tr class="text-[#7d6c5c] uppercase text-left border-b border-[#fff1e6]">
        <th class="py-1">Producto</th><th class="text-center">Vend./Comp.</th><th class="text-center">% Unid.</th><th class="text-right">Recuperado</th><th class="text-center">% $</th>
      </tr></thead>
      <tbody>
        ${s.items.map((it) => `
          <tr class="border-b border-[#fff1e6]">
            <td class="py-1.5 font-bold">${escapeHtml(it.name)}</td>
            <td class="text-center">${it.measured ? `${it.sold}/${it.qtyOrdered}` : '—'}</td>
            <td class="text-center">${it.measured ? it.unitsPct.toFixed(0) + '%' : '—'}</td>
            <td class="text-right">${it.measured ? money(it.recovered) : '—'}</td>
            <td class="text-center">${it.measured ? it.moneyPct.toFixed(0) + '%' : '—'}</td>
          </tr>`).join('')}
      </tbody>
    </table>
  `;
}

function wireEditorControls(el) {
  const margin = () => Number(el.querySelector('#h-margin').value) || 0;

  el.querySelector('#btn-add-row').addEventListener('click', () => {
    state.rows.push(newRow(margin()));
    renderRows(el);
  });
  el.querySelector('#btn-apply-margin').addEventListener('click', () => {
    const m = margin();
    state.rows.forEach((r) => { r.marginPct = m; r.salePrice = round2(r.unitCost * (1 + m / 100)); });
    renderRows(el);
  });
  el.querySelector('#btn-round-10').addEventListener('click', () => {
    state.rows.forEach((r) => { r.salePrice = Math.round(r.salePrice / 10) * 10; });
    renderRows(el);
  });
  el.querySelector('#btn-round-100').addEventListener('click', () => {
    state.rows.forEach((r) => { r.salePrice = Math.round(r.salePrice / 100) * 100; });
    renderRows(el);
  });
  el.querySelector('#btn-split').addEventListener('click', () => {
    state.rows.forEach((r) => {
      const q = Math.max(0, Math.trunc(r.qtyOrdered || 0));
      r.qtyLomas = Math.ceil(q / 2);     // mayor a Lomas si impar
      r.qtyBanfield = q - r.qtyLomas;
    });
    renderRows(el);
  });

  // Adjuntar factura (scan IA llega en Fase 5; por ahora solo guarda el documento)
  const docInput = el.querySelector('#doc-input');
  docInput?.addEventListener('change', async (ev) => {
    const file = ev.target.files?.[0];
    ev.target.value = '';
    if (!file) return;
    const purchaseId = await ensurePurchaseSaved(el);
    if (!purchaseId) return;
    const statusEl = el.querySelector('#doc-status');
    if (statusEl) statusEl.textContent = 'Subiendo...';
    try {
      await uploadFile(`/api/purchases/${encodeURIComponent(purchaseId)}/documents`, file);
      state.purchase = await api(`/api/purchases/${encodeURIComponent(purchaseId)}`);
      if (statusEl) statusEl.textContent = `${(state.purchase.documents || []).length} adjunto(s)`;
      const scanBtn = el.querySelector('#btn-scan');
      scanBtn?.classList.remove('opacity-50', 'pointer-events-none');
      toast('Factura adjuntada — podés escanearla con IA', 'success');
    } catch (err) {
      if (statusEl) statusEl.textContent = 'Error al adjuntar';
      toast(err.message, 'error');
    }
  });

  // Escaneo de factura con IA: extrae líneas y las vuelca al preview (con auto-match).
  const scanBtn = el.querySelector('#btn-scan');
  scanBtn?.addEventListener('click', async () => {
    const docs = state.purchase.documents || [];
    if (!docs.length) { toast('Adjuntá una factura primero', 'warn'); return; }
    const documentId = docs[docs.length - 1].id;
    const statusEl = el.querySelector('#doc-status');
    const prevTxt = statusEl?.textContent;
    if (statusEl) statusEl.textContent = 'Escaneando con IA...';
    scanBtn.classList.add('opacity-50', 'pointer-events-none');
    try {
      const res = await api(`/api/purchases/${encodeURIComponent(state.purchase.id)}/scan`, { method: 'POST', body: { documentId } });
      if (res.scanStatus === 'failed' || !res.lines?.length) {
        toast('No se pudieron extraer líneas. Cargá manual.', 'warn');
        return;
      }
      // Auto-match por barcode/sku de las líneas extraídas
      let matches = [];
      try {
        matches = await api('/api/purchases/match', { method: 'POST', body: { lines: res.lines.map((l) => ({ barcode: l.barcode, sku: null })) } });
      } catch { matches = []; }
      const m = Number(el.querySelector('#h-margin')?.value) || 100;
      const scanned = res.lines.map((l, i) => {
        const mt = matches[i] || {};
        const unitCost = l.costoUnitario || 0;
        return {
          id: null, variantId: mt.variantId || null, productId: mt.productId || null,
          matchType: mt.matchType || 'new',
          rawName: l.nombre || mt.productName || 'Sin nombre',
          barcode: l.barcode || '', sku: '',
          qtyOrdered: l.cantidad || 1,
          unitCost,
          marginPct: m,
          salePrice: round2(unitCost * (1 + m / 100)),
          qtyLomas: 0, qtyBanfield: 0, tnConfig: null, publishTn: false,
        };
      });
      // Mergeamos: si ya había filas cargadas, agregamos las escaneadas al final.
      state.rows = [...state.rows, ...scanned];
      // Si la factura trae tipo/número y el header está vacío, los sugerimos.
      if (res.invoiceType === 'A' || res.invoiceType === 'X') {
        const sel = el.querySelector('#h-invoice-type'); if (sel) sel.value = res.invoiceType;
      }
      if (res.invoiceNumber && el.querySelector('#h-invoice-number') && !el.querySelector('#h-invoice-number').value) {
        el.querySelector('#h-invoice-number').value = res.invoiceNumber;
      }
      renderRows(el);
      toast(`${scanned.length} línea(s) extraída(s)${res.scanStatus === 'partial' ? ' — revisá las dudosas' : ''}`, 'success');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'SCAN_UNAVAILABLE') {
        toast('Escaneo IA no configurado (falta API key). Cargá manual.', 'warn');
      } else {
        toast(err.message || 'Error al escanear', 'error');
      }
    } finally {
      if (statusEl) statusEl.textContent = prevTxt || `${(state.purchase.documents || []).length} adjunto(s)`;
      scanBtn.classList.remove('opacity-50', 'pointer-events-none');
    }
  });

  const saveBtn = el.querySelector('#btn-save');
  saveBtn?.addEventListener('click', async () => { await savePurchase(el); });
  const pendingBtn = el.querySelector('#btn-pending');
  pendingBtn?.addEventListener('click', async () => {
    const id = await savePurchase(el, { silent: true });
    if (!id) return;
    try {
      state.purchase = await api(`/api/purchases/${encodeURIComponent(id)}/status`, { method: 'PATCH', body: { status: 'pending' } });
      toast('Compra marcada como pendiente', 'success');
      render(el);
    } catch (err) { toast(err.message, 'error'); }
  });
  const receiveBtn = el.querySelector('#btn-receive');
  receiveBtn?.addEventListener('click', async () => {
    const ok = await confirmModal({
      title: 'Recibir mercadería',
      message: `Esto impacta el stock de las ${state.rows.length} líneas, crea/actualiza productos y publica en Tienda Nube los marcados. ¿Confirmás?`,
      confirmLabel: 'Recibir',
    });
    if (!ok) return;
    receiveBtn.disabled = true;
    try {
      state.purchase = await api(`/api/purchases/${encodeURIComponent(state.purchase.id)}/receive`, { method: 'POST' });
      state.rows = state.purchase.items.map(itemToRow);
      toast('Mercadería recibida — stock actualizado', 'success');
      render(el);
    } catch (err) {
      receiveBtn.disabled = false;
      toast(err.message, 'error');
    }
  });
}

function renderRows(el) {
  const body = el.querySelector('#items-body');
  const emptyEl = el.querySelector('#items-empty');
  const readonly = state.purchase.status === 'received' || state.purchase.status === 'cancelled';
  if (!body) return;
  if (state.rows.length === 0) {
    body.innerHTML = '';
    if (emptyEl) emptyEl.textContent = readonly ? 'Sin items.' : 'Agregá filas con "Fila" o adjuntá una factura.';
    return;
  }
  if (emptyEl) emptyEl.textContent = `${state.rows.length} línea(s) · Total ${money(state.rows.reduce((s, r) => s + r.unitCost * r.qtyOrdered, 0))}`;
  const matchBadge = (r) => {
    if (r.matchType === 'matched_barcode' || r.matchType === 'matched_sku') {
      return '<span class="px-2 py-0.5 rounded-full text-xs font-bold bg-green-100 text-green-800" title="Producto existente: suma stock y actualiza costo">existe</span>';
    }
    return '<span class="px-2 py-0.5 rounded-full text-xs font-bold bg-blue-100 text-blue-800">nuevo</span>';
  };
  const inp = (field, val, type = 'text', extra = '') =>
    `<input data-field="${field}" type="${type}" ${type === 'number' ? 'step="0.01"' : ''} value="${escapeHtml(String(val ?? ''))}" class="w-full bg-transparent border border-transparent hover:border-[#e3ceba] focus:border-[#d82f1e] rounded px-1 py-0.5 text-sm ${extra}" ${readonly ? 'disabled' : ''} />`;

  body.innerHTML = state.rows.map((r, i) => `
    <tr data-idx="${i}">
      <td class="min-w-[180px]">${inp('rawName', r.rawName, 'text', 'font-bold')}</td>
      <td class="min-w-[140px]">${inp('barcode', r.barcode)}</td>
      <td class="min-w-[100px]">${inp('sku', r.sku)}</td>
      <td class="w-16 text-center">${inp('qtyOrdered', r.qtyOrdered, 'number')}</td>
      <td class="w-24 text-right">${inp('unitCost', r.unitCost, 'number')}</td>
      <td class="w-20 text-right">${inp('marginPct', r.marginPct, 'number')}</td>
      <td class="w-24 text-right">${inp('salePrice', r.salePrice, 'number')}</td>
      <td class="w-16 text-center">${inp('qtyLomas', r.qtyLomas, 'number')}</td>
      <td class="w-16 text-center">${inp('qtyBanfield', r.qtyBanfield, 'number')}</td>
      <td class="text-center">${matchBadge(r)}</td>
      <td class="text-center">
        <button data-tn="${i}" class="px-2 py-1 rounded-full text-xs font-bold ${r.publishTn ? 'bg-[#d82f1e] text-white' : 'bg-gray-100 text-[#7d6c5c]'}" ${readonly ? 'disabled' : ''} title="Publicar en Tienda Nube">
          ${r.publishTn ? 'TN ✓' : 'TN'}
        </button>
      </td>
      ${readonly ? '' : `<td class="text-right"><button data-del="${i}" class="p-1 hover:bg-red-50 rounded-full"><span class="material-symbols-outlined text-base text-red-500">delete</span></button></td>`}
    </tr>
  `).join('');

  if (readonly) return;

  body.querySelectorAll('tr[data-idx]').forEach((tr) => {
    const idx = Number(tr.dataset.idx);
    tr.querySelectorAll('input[data-field]').forEach((input) => {
      input.addEventListener('input', () => {
        const f = input.dataset.field;
        const row = state.rows[idx];
        if (['qtyOrdered', 'unitCost', 'marginPct', 'salePrice', 'qtyLomas', 'qtyBanfield'].includes(f)) {
          row[f] = Number(input.value) || 0;
        } else {
          row[f] = input.value;
        }
        // Recalcular precio si cambió costo o margen
        if (f === 'unitCost' || f === 'marginPct') {
          row.salePrice = round2(row.unitCost * (1 + row.marginPct / 100));
          const priceInput = tr.querySelector('input[data-field="salePrice"]');
          if (priceInput) priceInput.value = row.salePrice;
        }
      });
      // Match al confirmar barcode/sku (Enter del lector USB o blur)
      if (input.dataset.field === 'barcode' || input.dataset.field === 'sku') {
        const tryMatch = () => matchRow(el, idx);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); tryMatch(); } });
        input.addEventListener('blur', tryMatch);
      }
    });
    const delBtn = tr.querySelector('[data-del]');
    delBtn?.addEventListener('click', () => { state.rows.splice(idx, 1); renderRows(el); });
    const tnBtn = tr.querySelector('[data-tn]');
    tnBtn?.addEventListener('click', () => openTnForRow(el, idx));
  });
}

// Abre el modal TN para una fila: requiere compra guardada (para subir imágenes a staging).
async function openTnForRow(el, idx) {
  const row = state.rows[idx];
  if (!row) return;
  const purchaseId = await ensurePurchaseSaved(el);
  // El índice puede haberse mantenido; reusar la fila vigente.
  const liveRow = state.rows[idx] || row;
  const uploadImage = purchaseId
    ? async (file) => uploadFile(`/api/purchases/${encodeURIComponent(purchaseId)}/staging-image`, file)
    : null;
  const cfg = await openTnProductModal({ initial: liveRow.tnConfig, uploadImage });
  if (cfg === null) return; // cancelado
  liveRow.tnConfig = cfg;
  liveRow.publishTn = true; // al guardar datos TN, queda marcado para publicar
  renderRows(el);
}

async function matchRow(el, idx) {
  const row = state.rows[idx];
  if (!row || (!row.barcode?.trim() && !row.sku?.trim())) return;
  try {
    const [res] = await api('/api/purchases/match', { method: 'POST', body: { lines: [{ barcode: row.barcode, sku: row.sku }] } });
    if (!res) return;
    row.matchType = res.matchType;
    row.variantId = res.variantId;
    row.productId = res.productId;
    if (res.matchType.startsWith('matched')) {
      // Sugerir costo/precio actuales si la fila está vacía
      if (!row.rawName && res.productName) row.rawName = res.productName;
      if (!row.unitCost && res.currentCost) row.unitCost = res.currentCost;
      renderRows(el);
    } else {
      renderRows(el);
    }
  } catch { /* match es best-effort */ }
}

// Crea la compra en backend si todavía es borrador en memoria; devuelve el id.
async function ensurePurchaseSaved(el) {
  if (state.purchase.id) return state.purchase.id;
  return savePurchase(el, { silent: true });
}

async function savePurchase(el, { silent = false } = {}) {
  const p = state.purchase;
  const supplierId = el.querySelector('#h-supplier')?.value || null;
  const supplierName = supplierId ? (state.suppliers.find((s) => s.id === supplierId)?.name || null) : null;
  const header = {
    branchId: el.querySelector('#h-branch')?.value || p.branchId,
    supplierId,
    supplierName,
    invoiceType: el.querySelector('#h-invoice-type')?.value || 'A',
    invoiceNumber: el.querySelector('#h-invoice-number')?.value || null,
    marginPctDefault: Number(el.querySelector('#h-margin')?.value) || 100,
  };
  const items = state.rows.map((r) => ({
    variantId: r.variantId, productId: r.productId, matchType: r.matchType,
    rawName: r.rawName?.trim() || 'Sin nombre',
    barcode: r.barcode || null, sku: r.sku || null,
    qtyOrdered: Math.trunc(r.qtyOrdered) || 0, unitCost: r.unitCost || 0,
    marginPct: r.marginPct || 0, salePrice: r.salePrice || 0,
    qtyLomas: Math.trunc(r.qtyLomas) || 0, qtyBanfield: Math.trunc(r.qtyBanfield) || 0,
    tnConfig: r.tnConfig, publishTn: !!r.publishTn,
  }));
  try {
    if (!p.id) {
      const created = await api('/api/purchases', { method: 'POST', body: header });
      state.purchase = await api(`/api/purchases/${encodeURIComponent(created.id)}`, {
        method: 'PUT', body: { ...header, items },
      });
    } else {
      state.purchase = await api(`/api/purchases/${encodeURIComponent(p.id)}`, {
        method: 'PUT', body: { ...header, items },
      });
    }
    state.rows = state.purchase.items.map(itemToRow);
    if (!silent) toast('Compra guardada', 'success');
    return state.purchase.id;
  } catch (err) {
    toast(err.message, 'error');
    return null;
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
