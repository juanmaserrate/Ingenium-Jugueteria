// Módulo Mercado Libre: conectar/desconectar la cuenta, ver estado del token y probar la
// conexión. Fase 0 (fundaciones). El resto (stock, órdenes, publicar) se agrega por fases.

import { api, ApiError, getApiBase, getToken } from '../core/api.js';
import { toast } from '../core/notifications.js';

export async function mount(el) {
  el.innerHTML = renderShell();

  let branches = [];
  try { branches = await api('/auth/branches'); } catch { branches = []; }
  const branchOpts = (branches || []).map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('');

  // Mensajes del callback de OAuth (?connected=1 / ?error=...)
  const hash = location.hash || '';
  if (hash.includes('connected=1')) toast('Mercado Libre conectado', 'success');
  const errMatch = hash.match(/[?&]error=([^&]+)/);
  if (errMatch) toast('No se pudo conectar Mercado Libre: ' + decodeURIComponent(errMatch[1]), 'error');

  el.querySelector('#btn-connect').addEventListener('click', () => {
    window.location.href = `${getApiBase()}/api/integrations/ml/authorize`;
  });

  el.querySelector('#btn-disconnect').addEventListener('click', async () => {
    if (!confirm('¿Desconectar Mercado Libre?')) return;
    try {
      await api('/api/integrations/ml/disconnect', { method: 'POST' });
      toast('Desconectado de Mercado Libre', 'success');
      refresh();
    } catch (err) { toast(err.message, 'error'); }
  });

  el.querySelector('#btn-test').addEventListener('click', async () => {
    const out = el.querySelector('#test-out');
    out.textContent = 'Probando…';
    try {
      const me = await api('/api/integrations/ml/me');
      out.innerHTML = `<span class="text-green-700 font-bold">✓ OK</span> — ${me.nickname ?? ''} (id ${me.id ?? '-'}, ${me.site_id ?? '-'})`;
    } catch (err) {
      out.innerHTML = `<span class="text-red-600 font-bold">✗ ${err.message}</span>`;
    }
  });

  async function refresh() {
    try {
      const s = await api('/api/integrations/ml/status');
      const badge = !s.configured
        ? '<span class="px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 text-xs font-bold">Falta configurar credenciales</span>'
        : s.connected
          ? '<span class="px-2 py-0.5 rounded-full bg-green-100 text-green-800 text-xs font-bold">Conectado</span>'
          : '<span class="px-2 py-0.5 rounded-full bg-gray-200 text-gray-700 text-xs font-bold">Desconectado</span>';
      el.querySelector('#status-badge').innerHTML = badge;
      el.querySelector('#ml-user-id').textContent = s.mlUserId ?? '-';
      el.querySelector('#ml-connected-at').textContent = s.connectedAt ? new Date(s.connectedAt).toLocaleString('es-AR') : '-';
      el.querySelector('#ml-token-exp').textContent = s.tokenExpiresAt ? new Date(s.tokenExpiresAt).toLocaleString('es-AR') : '-';
      el.querySelector('#not-configured').classList.toggle('hidden', !!s.configured);
      el.querySelector('#btn-connect').classList.toggle('hidden', !s.configured || s.connected);
      el.querySelector('#btn-disconnect').classList.toggle('hidden', !s.connected);
      el.querySelector('#btn-test').classList.toggle('hidden', !s.connected);
      el.querySelector('#ml-link-box').classList.toggle('hidden', !s.connected);
      el.querySelector('#ml-orders-box').classList.toggle('hidden', !s.connected);
      el.querySelector('#ml-publish-box').classList.toggle('hidden', !s.connected);
      el.querySelector('#ml-bulk-box').classList.toggle('hidden', !s.connected);
      if (s.connected) { await loadOrders(); await loadMappings(); await loadBulkCats(); }
    } catch (err) {
      if (err instanceof ApiError && err.status === 0) {
        el.querySelector('#status-badge').innerHTML = '<span class="px-2 py-0.5 rounded-full bg-red-100 text-red-800 text-xs font-bold">Backend offline</span>';
      } else { toast(err.message, 'error'); }
    }
  }

  async function loadOrders() {
    try {
      const orders = await api('/api/ml-orders?status=pending');
      const box = el.querySelector('#ml-orders-list');
      if (!orders || !orders.length) { box.innerHTML = '<p class="text-sm text-[#7d6c5c]">No hay ventas de Mercado Libre pendientes de asignar.</p>'; return; }
      box.innerHTML = orders.map((o) => {
        const items = (o.items || []).map((i) => `${i.qty}× ${esc(i.title || i.mlItemId)}`).join(', ');
        return `
        <div class="border border-[#fff1e6] rounded-xl p-3 flex items-center justify-between gap-3 flex-wrap">
          <div class="min-w-0">
            <div class="font-bold text-sm">Orden #${esc(o.mlOrderId)} · ${esc(o.customerName)} · <span class="text-[#d82f1e]">$${o.total}</span></div>
            <div class="text-xs text-[#7d6c5c] truncate">${esc(items)}</div>
          </div>
          <div class="flex items-center gap-2">
            <select data-br="${esc(o.id)}" class="px-3 py-1.5 rounded-lg border border-[#fff1e6] text-sm">${branchOpts}</select>
            <button data-assign="${esc(o.id)}" class="px-3 py-1.5 bg-[#d82f1e] text-white rounded-lg font-bold text-sm">Asignar</button>
          </div>
        </div>`;
      }).join('');
      box.querySelectorAll('[data-assign]').forEach((b) => b.addEventListener('click', () => assignOrder(b.dataset.assign)));
    } catch (err) { console.error(err); }
  }

  async function assignOrder(id, allowNegative = false) {
    const branchId = el.querySelector(`[data-br="${id}"]`)?.value;
    if (!branchId) { toast('Elegí una sucursal', 'warn'); return; }
    try {
      const res = await api(`/api/ml-orders/${id}/assign`, { method: 'POST', body: { branchId, allowNegative } });
      if (res && res.error === 'unmapped_items') {
        toast('Hay ítems sin vincular a un producto. Vinculá sus publicaciones abajo y reintentá.', 'error');
        return;
      }
      toast('Venta registrada y stock descontado', 'success');
      loadOrders(); loadMappings();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.code === 'STOCK_INSUFFICIENT') {
        if (confirm('No alcanza el stock. ¿Confirmar igual? (el stock puede quedar negativo)')) return assignOrder(id, true);
        return;
      }
      toast(err.message, 'error');
    }
  }

  async function loadMappings() {
    try {
      const maps = await api('/api/integrations/ml/mappings');
      const rows = (maps || []).map((m) => `
        <tr class="border-b border-[#fff1e6]">
          <td class="py-1 px-2 text-sm font-bold">${esc(m.productName)}${m.variantName && m.variantName !== 'default' ? ` <span class="text-[#7d6c5c] font-normal">· ${esc(m.variantName)}</span>` : ''}</td>
          <td class="py-1 px-2 text-xs font-mono">${esc(m.mlItemId)}${m.mlVariationId ? ` / ${esc(m.mlVariationId)}` : ''}</td>
          <td class="py-1 px-2 text-sm text-right">${m.stock}</td>
          <td class="py-1 px-2 text-xs">${m.lastPushAt ? new Date(m.lastPushAt).toLocaleString('es-AR') : '—'}</td>
          <td class="py-1 px-2 text-right"><button data-unlink="${esc(m.variantId)}" class="text-xs text-[#7d6c5c] hover:text-red-600">Desvincular</button></td>
        </tr>`).join('');
      el.querySelector('#ml-maps tbody').innerHTML = rows || '<tr><td colspan="5" class="py-4 text-center text-sm text-[#7d6c5c]">Sin publicaciones vinculadas todavía</td></tr>';
      el.querySelectorAll('[data-unlink]').forEach((b) => b.addEventListener('click', async () => {
        if (!confirm('¿Desvincular esta publicación?')) return;
        try { await api('/api/integrations/ml/unlink', { method: 'POST', body: { variantId: b.dataset.unlink } }); toast('Desvinculado', 'success'); loadMappings(); }
        catch (err) { toast(err.message, 'error'); }
      }));
    } catch (err) { console.error(err); }
  }

  el.querySelector('#btn-link').addEventListener('click', async () => {
    const barcode = el.querySelector('#link-barcode').value.trim();
    const mlItemId = el.querySelector('#link-item').value.trim();
    const mlVariationId = el.querySelector('#link-variation').value.trim();
    if (!barcode || !mlItemId) { toast('Completá código de barras e ítem de ML', 'warn'); return; }
    try {
      await api('/api/integrations/ml/link', { method: 'POST', body: { barcode, mlItemId, mlVariationId: mlVariationId || undefined } });
      toast('Vinculado — el stock se empuja a ML', 'success');
      el.querySelector('#link-barcode').value = ''; el.querySelector('#link-item').value = ''; el.querySelector('#link-variation').value = '';
      loadMappings();
    } catch (err) { toast(err.message, 'error'); }
  });

  el.querySelector('#btn-predict').addEventListener('click', async () => {
    const title = el.querySelector('#pub-title').value.trim() || el.querySelector('#pub-barcode').value.trim();
    if (!title) { toast('Poné un título o código para predecir', 'warn'); return; }
    const out = el.querySelector('#predict-out');
    out.textContent = 'Prediciendo…';
    try {
      const preds = await api(`/api/integrations/ml/predict-category?title=${encodeURIComponent(title)}`);
      if (!preds || !preds.length) { out.textContent = 'Sin sugerencias; cargá la categoría a mano.'; return; }
      el.querySelector('#pub-category').value = preds[0].categoryId;
      out.innerHTML = 'Sugerencias: ' + preds.map((p) => `<button type="button" data-cat="${esc(p.categoryId)}" class="underline text-[#d82f1e]">${esc(p.categoryName)} (${esc(p.categoryId)})</button>`).join(' · ');
      out.querySelectorAll('[data-cat]').forEach((b) => b.addEventListener('click', () => { el.querySelector('#pub-category').value = b.dataset.cat; }));
    } catch (err) { out.innerHTML = `<span class="text-red-600">${err.message}</span>`; }
  });

  el.querySelector('#btn-publish').addEventListener('click', async () => {
    const barcode = el.querySelector('#pub-barcode').value.trim();
    const listingTypeId = el.querySelector('#pub-listing').value;
    if (!barcode) { toast('Poné el código de barras del producto', 'warn'); return; }
    const body = { barcode, listingTypeId, condition: el.querySelector('#pub-condition').value };
    const cat = el.querySelector('#pub-category').value.trim(); if (cat) body.categoryId = cat;
    const title = el.querySelector('#pub-title').value.trim(); if (title) body.title = title;
    const price = Number(el.querySelector('#pub-price').value); if (price > 0) body.price = price;
    const qty = el.querySelector('#pub-qty').value; if (qty !== '') body.quantity = Number(qty);
    const out = el.querySelector('#publish-out');
    if (!confirm('Esto va a CREAR una publicación real en tu cuenta de Mercado Libre. ¿Confirmás?')) return;
    out.textContent = 'Publicando…';
    try {
      const res = await api('/api/integrations/ml/publish', { method: 'POST', body });
      out.innerHTML = `<span class="text-green-700 font-bold">✓ Publicado</span> — ${esc(res.itemId)} ${res.permalink ? `· <a href="${esc(res.permalink)}" target="_blank" class="underline text-[#d82f1e]">ver</a>` : ''}`;
      toast('Publicación creada y stock vinculado', 'success');
      loadMappings();
    } catch (err) {
      const det = err?.body?.details ? (typeof err.body.details === 'string' ? err.body.details : JSON.stringify(err.body.details)) : err.message;
      out.innerHTML = `<span class="text-red-600 font-bold">✗ ${esc(err?.body?.message || err.message)}</span><br/><span class="text-xs text-[#7d6c5c]">${esc(det)}</span>`;
    }
  });

  // ---- Publicar por categoría (lote) ----
  let bulkItems = [];
  async function loadBulkCats() {
    const box = el.querySelector('#bulk-cats');
    if (!box || box.dataset.loaded) return;
    let cats = [];
    try { cats = await api('/api/categories'); } catch { cats = []; }
    box.innerHTML = (cats || []).length
      ? cats.map((c) => `<label class="flex items-center gap-2"><input type="checkbox" class="bulk-cat" value="${esc(c.id)}" /> ${esc(c.name)}</label>`).join('')
      : '<span class="text-xs text-[#7d6c5c]">No hay categorías cargadas</span>';
    box.dataset.loaded = '1';
  }

  const CHIP = {
    linked: '<span class="px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 text-xs font-bold">✓ ya vinculada</span>',
    match: '<span class="px-2 py-0.5 rounded-full bg-blue-100 text-blue-800 text-xs font-bold">🔗 a vincular</span>',
    new: '<span class="px-2 py-0.5 rounded-full bg-green-100 text-green-800 text-xs font-bold">🆕 nueva</span>',
    skip: '<span class="px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 text-xs font-bold">⚠ salteada</span>',
  };
  const money = (n) => '$' + Number(n || 0).toLocaleString('es-AR');

  function renderBulkPlan(plan) {
    bulkItems = plan.items || [];
    const out = el.querySelector('#bulk-plan-out');
    const n = { linked: 0, match: 0, new: 0, skip: 0 };
    for (const it of bulkItems) n[it.status]++;
    const scanWarn = plan.scan && !plan.scan.available
      ? '<div class="text-xs text-amber-700 mb-2">⚠ No pude escanear tus publicaciones de ML (¿conexión?). Reviso solo lo que el sistema ya sabe; podrían duplicarse las que ya existan.</div>'
      : `<div class="text-xs text-[#7d6c5c] mb-2">Escaneé ${plan.scan?.scanned ?? 0} publicaciones tuyas de ML para detectar las que ya existen.</div>`;
    if (!bulkItems.length) { out.innerHTML = 'No hay productos en esas categorías.'; return; }
    const rows = bulkItems.map((it, i) => {
      const actionable = it.status === 'new' || (it.status === 'match' && !!it.mlItemId && (it.status !== 'match' || !!it.linkBarcode));
      const canLink = it.status === 'match' && !!it.linkBarcode;
      const checked = it.status === 'new' || (it.status === 'match' && it.matchBy === 'sku' && canLink);
      const cb = (it.status === 'new' || canLink)
        ? `<input type="checkbox" class="bulk-row" data-idx="${i}" ${checked ? 'checked' : ''} />`
        : (it.status === 'match' && !canLink ? '<span class="text-[11px] text-amber-700">sin código → vinc. a mano</span>' : '');
      const extra = it.status === 'match'
        ? `<a href="https://articulo.mercadolibre.com.ar/${esc(it.mlItemId)}" target="_blank" class="underline text-[#d82f1e]">${esc(it.mlItemId)}</a> <span class="text-[11px] text-[#7d6c5c]">(${it.matchBy === 'sku' ? 'por código' : 'por título'})</span>`
        : it.status === 'skip' ? `<span class="text-[11px] text-amber-700">${esc(it.reason || '')}</span>`
        : it.status === 'linked' ? `<span class="text-[11px] text-[#7d6c5c]">${esc(it.mlItemId || '')}</span>` : '';
      return `<tr class="border-t border-[#fff1e6]">
        <td class="py-1 px-2">${cb}</td>
        <td class="py-1 px-2">${CHIP[it.status] || ''}</td>
        <td class="py-1 px-2">${esc(it.name)}${it.variantsCount > 1 ? ` <span class="text-[11px] text-[#7d6c5c]">(${it.variantsCount} var.)</span>` : ''}</td>
        <td class="py-1 px-2 text-right">${it.stock}</td>
        <td class="py-1 px-2 text-right">${money(it.price)}</td>
        <td class="py-1 px-2">${extra}</td>
      </tr>`;
    }).join('');
    out.innerHTML = `
      ${scanWarn}
      <div class="flex flex-wrap gap-2 text-xs mb-2">
        <span>Total: <b>${bulkItems.length}</b></span> · <span>${CHIP.new} ${n.new}</span> · <span>${CHIP.match} ${n.match}</span> · <span>${CHIP.linked} ${n.linked}</span> · <span>${CHIP.skip} ${n.skip}</span>
      </div>
      <div class="overflow-auto max-h-96 border border-[#fff1e6] rounded-xl">
      <table class="w-full text-sm">
        <thead class="sticky top-0 bg-white"><tr class="text-left text-xs text-[#7d6c5c] uppercase">
          <th class="py-2 px-2"><input type="checkbox" id="bulk-all" /></th><th class="py-2 px-2">Estado</th><th class="py-2 px-2">Producto</th><th class="py-2 px-2 text-right">Stock</th><th class="py-2 px-2 text-right">Precio</th><th class="py-2 px-2">Ítem ML / motivo</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <div class="flex items-center gap-3 mt-3">
        <button id="btn-bulk-run" class="px-4 py-2 bg-[#d82f1e] text-white rounded-xl font-bold">Ejecutar seleccionadas</button>
        <span class="text-xs text-[#7d6c5c]">Crea/vincula publicaciones reales en tu cuenta.</span>
      </div>
      <div id="bulk-run-log" class="mt-3 space-y-1 text-sm max-h-72 overflow-auto"></div>`;

    const allCb = el.querySelector('#bulk-all');
    if (allCb) allCb.addEventListener('change', () => { el.querySelectorAll('.bulk-row').forEach((c) => { c.checked = allCb.checked; }); });
    el.querySelector('#btn-bulk-run').addEventListener('click', runBulk);
  }

  async function runBulk() {
    const picked = [...el.querySelectorAll('.bulk-row:checked')].map((c) => bulkItems[Number(c.dataset.idx)]).filter(Boolean);
    if (!picked.length) { toast('No seleccionaste ninguna', 'warn'); return; }
    const listingTypeId = el.querySelector('#bulk-listing').value;
    if (!confirm(`Esto va a CREAR/VINCULAR ${picked.length} publicaciones reales en tu cuenta de Mercado Libre. ¿Confirmás?`)) return;
    const log = el.querySelector('#bulk-run-log');
    const runBtn = el.querySelector('#btn-bulk-run');
    runBtn.disabled = true; runBtn.textContent = 'Ejecutando…';
    let ok = 0, fail = 0;
    for (const it of picked) {
      const line = document.createElement('div');
      line.innerHTML = `⏳ ${esc(it.name)}…`;
      log.prepend(line);
      try {
        if (it.status === 'match' && it.mlItemId && it.linkBarcode) {
          await api('/api/integrations/ml/link', { method: 'POST', body: { barcode: it.linkBarcode, mlItemId: it.mlItemId } });
          line.innerHTML = `🔗 ${esc(it.name)} — vinculada a ${esc(it.mlItemId)}`;
        } else {
          const res = await api('/api/integrations/ml/publish', { method: 'POST', body: { productId: it.productId, listingTypeId } });
          line.innerHTML = res.alreadyLinked ? `✓ ${esc(it.name)} — ya estaba publicada` : `🆕 ${esc(it.name)} — ${esc(res.itemId)}${res.permalink ? ` · <a href="${esc(res.permalink)}" target="_blank" class="underline text-[#d82f1e]">ver</a>` : ''}`;
        }
        ok++;
      } catch (err) {
        const det = err?.body?.details ? (typeof err.body.details === 'string' ? err.body.details : JSON.stringify(err.body.details)) : (err?.body?.message || err.message);
        line.innerHTML = `✗ ${esc(it.name)} — ${esc(det)}`;
        fail++;
      }
    }
    runBtn.disabled = false; runBtn.textContent = 'Ejecutar seleccionadas';
    toast(`Lote terminado: ${ok} ok, ${fail} con error`, fail ? 'warn' : 'success');
    loadMappings();
  }

  el.querySelector('#btn-bulk-plan').addEventListener('click', async () => {
    const categoryIds = [...el.querySelectorAll('.bulk-cat:checked')].map((c) => c.value);
    if (!categoryIds.length) { toast('Elegí al menos una categoría', 'warn'); return; }
    const includeZeroStock = el.querySelector('#bulk-zero').checked;
    const out = el.querySelector('#bulk-plan-out');
    out.innerHTML = '<span class="text-[#7d6c5c]">Analizando productos y escaneando tus publicaciones de ML… (puede tardar unos segundos)</span>';
    try {
      const plan = await api('/api/integrations/ml/bulk-plan', { method: 'POST', body: { categoryIds, includeZeroStock } });
      renderBulkPlan(plan);
    } catch (err) {
      out.innerHTML = `<span class="text-red-600 font-bold">✗ ${esc(err?.body?.error || err.message)}</span>`;
    }
  });

  if (!getToken()) toast('Necesitás iniciar sesión para usar esta sección', 'warning');
  await refresh();
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function renderShell() {
  return `
    <div class="max-w-5xl mx-auto space-y-6">
      <header>
        <h1 class="text-3xl font-black text-[#241a0d]">Mercado Libre</h1>
        <p class="text-[#7d6c5c] text-sm">Conectá tu cuenta para sincronizar stock y traer ventas. Se construye por fases.</p>
      </header>

      <div id="not-configured" class="hidden bg-amber-50 border border-amber-200 rounded-2xl p-4 text-sm text-[#241a0d]">
        <b>Falta cargar las credenciales.</b> Hay que crear la app en el DevCenter de Mercado Libre y cargar
        <code>ML_CLIENT_ID</code> y <code>ML_CLIENT_SECRET</code> en Railway. Una vez hecho, aparece el botón Conectar.
      </div>

      <section class="bg-white rounded-2xl shadow-sm border border-[#fff1e6] p-6 space-y-4">
        <div class="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h2 class="text-lg font-bold flex items-center gap-3">Cuenta <span id="status-badge"></span></h2>
            <p class="text-xs text-[#7d6c5c]">El token se renueva solo (refresh automático).</p>
          </div>
          <div class="flex gap-2">
            <button id="btn-connect" class="px-4 py-2 bg-[#d82f1e] text-white rounded-xl font-bold flex items-center gap-2 hidden">
              <span class="material-symbols-outlined text-base">link</span> Conectar
            </button>
            <button id="btn-test" class="px-4 py-2 bg-gray-100 text-[#241a0d] rounded-xl font-bold hidden">Probar conexión</button>
            <button id="btn-disconnect" class="px-4 py-2 bg-gray-200 text-[#241a0d] rounded-xl font-bold hidden">Desconectar</button>
          </div>
        </div>
        <div class="grid grid-cols-3 gap-4 text-sm">
          <div><span class="text-[#7d6c5c] text-xs uppercase">Seller ID</span><br/><span id="ml-user-id" class="font-mono"></span></div>
          <div><span class="text-[#7d6c5c] text-xs uppercase">Conectado</span><br/><span id="ml-connected-at"></span></div>
          <div><span class="text-[#7d6c5c] text-xs uppercase">Token vence</span><br/><span id="ml-token-exp"></span></div>
        </div>
        <div id="test-out" class="text-sm text-[#7d6c5c]"></div>
      </section>

      <section id="ml-orders-box" class="hidden bg-white rounded-2xl shadow-sm border border-[#fff1e6] p-6 space-y-4">
        <div>
          <h2 class="text-lg font-bold">Ventas de Mercado Libre pendientes</h2>
          <p class="text-xs text-[#7d6c5c]">Asigná cada venta a una sucursal: se registra como venta (con su comisión real de Mercado Pago) y descuenta el stock.</p>
        </div>
        <div id="ml-orders-list" class="space-y-2"></div>
      </section>

      <section id="ml-link-box" class="hidden bg-white rounded-2xl shadow-sm border border-[#fff1e6] p-6 space-y-4">
        <div>
          <h2 class="text-lg font-bold">Publicaciones vinculadas (stock)</h2>
          <p class="text-xs text-[#7d6c5c]">Vinculá cada publicación de ML a un producto por su código de barras. Desde ahí, cada venta (POS/TN/ML) descuenta el stock en ML automáticamente.</p>
        </div>
        <div class="flex flex-wrap gap-2 items-end">
          <div><label class="text-xs font-bold text-[#7d6c5c] uppercase block mb-1">Código de barras / SKU</label><input id="link-barcode" class="px-3 py-2 rounded-xl border border-[#fff1e6] w-56" placeholder="del producto en el sistema" /></div>
          <div><label class="text-xs font-bold text-[#7d6c5c] uppercase block mb-1">Ítem de ML (MLA…)</label><input id="link-item" class="px-3 py-2 rounded-xl border border-[#fff1e6] w-44" placeholder="MLA123456789" /></div>
          <div><label class="text-xs font-bold text-[#7d6c5c] uppercase block mb-1">Variación (opcional)</label><input id="link-variation" class="px-3 py-2 rounded-xl border border-[#fff1e6] w-40" placeholder="id de variación" /></div>
          <button id="btn-link" class="px-4 py-2 bg-[#d82f1e] text-white rounded-xl font-bold">Vincular</button>
        </div>
        <table id="ml-maps" class="w-full">
          <thead><tr class="text-left text-xs text-[#7d6c5c] uppercase">
            <th class="py-2 px-2">Producto</th><th class="py-2 px-2">Ítem ML</th><th class="py-2 px-2 text-right">Stock</th><th class="py-2 px-2">Último push</th><th class="py-2 px-2"></th>
          </tr></thead>
          <tbody></tbody>
        </table>
      </section>

      <section id="ml-publish-box" class="hidden bg-white rounded-2xl shadow-sm border border-[#fff1e6] p-6 space-y-3">
        <div>
          <h2 class="text-lg font-bold">Publicar en Mercado Libre</h2>
          <p class="text-xs text-[#7d6c5c]">Creá una publicación desde un producto del sistema. <b>Crea contenido real en tu cuenta</b> (te pide confirmar). Si ML rechaza por categoría o atributos faltantes, te muestro el detalle para corregir. Al publicar queda vinculada y el stock se sincroniza solo.</p>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div><label class="text-xs font-bold text-[#7d6c5c] uppercase block mb-1">Código de barras / SKU</label><input id="pub-barcode" class="px-3 py-2 rounded-xl border border-[#fff1e6] w-full" placeholder="del producto" /></div>
          <div><label class="text-xs font-bold text-[#7d6c5c] uppercase block mb-1">Título (opcional, máx 60)</label><input id="pub-title" maxlength="60" class="px-3 py-2 rounded-xl border border-[#fff1e6] w-full" placeholder="usa el nombre del producto" /></div>
          <div><label class="text-xs font-bold text-[#7d6c5c] uppercase block mb-1">Precio (opcional)</label><input id="pub-price" type="number" class="px-3 py-2 rounded-xl border border-[#fff1e6] w-full" placeholder="usa el del sistema" /></div>
          <div><label class="text-xs font-bold text-[#7d6c5c] uppercase block mb-1">Cantidad (opcional)</label><input id="pub-qty" type="number" class="px-3 py-2 rounded-xl border border-[#fff1e6] w-full" placeholder="usa el stock" /></div>
          <div><label class="text-xs font-bold text-[#7d6c5c] uppercase block mb-1">Tipo de publicación</label>
            <select id="pub-listing" class="px-3 py-2 rounded-xl border border-[#fff1e6] w-full">
              <option value="free">Gratuita</option><option value="gold_special" selected>Clásica</option><option value="gold_pro">Premium</option>
            </select></div>
          <div><label class="text-xs font-bold text-[#7d6c5c] uppercase block mb-1">Condición</label>
            <select id="pub-condition" class="px-3 py-2 rounded-xl border border-[#fff1e6] w-full"><option value="new">Nuevo</option><option value="used">Usado</option></select></div>
          <div class="col-span-2 flex items-end gap-2">
            <div class="flex-1"><label class="text-xs font-bold text-[#7d6c5c] uppercase block mb-1">Categoría ML (si vacío, se predice)</label><input id="pub-category" class="px-3 py-2 rounded-xl border border-[#fff1e6] w-full" placeholder="MLA…" /></div>
            <button id="btn-predict" class="px-3 py-2 bg-gray-100 text-[#241a0d] rounded-xl font-bold">Predecir</button>
          </div>
        </div>
        <div id="predict-out" class="text-xs text-[#7d6c5c]"></div>
        <div class="flex items-center gap-3">
          <button id="btn-publish" class="px-4 py-2 bg-[#d82f1e] text-white rounded-xl font-bold">Publicar</button>
          <div id="publish-out" class="text-sm"></div>
        </div>
      </section>

      <section id="ml-bulk-box" class="hidden bg-white rounded-2xl shadow-sm border border-[#fff1e6] p-6 space-y-3">
        <div>
          <h2 class="text-lg font-bold">Publicar por categoría (lote)</h2>
          <p class="text-xs text-[#7d6c5c]">Elegí una o más categorías y tocá <b>Previsualizar</b>. Te muestro el plan: <b>ya vinculadas</b>, <b>a vincular</b> (ya existen en ML, por código o título — no se duplican), <b>nuevas a publicar</b> y <b>salteadas</b> (sin precio/foto/stock). <b>Nada se publica hasta que confirmes.</b> Precio y stock salen del sistema.</p>
        </div>
        <div class="flex flex-wrap gap-4 items-start">
          <div>
            <label class="text-xs font-bold text-[#7d6c5c] uppercase block mb-1">Categorías</label>
            <div id="bulk-cats" class="max-h-52 overflow-auto border border-[#fff1e6] rounded-xl p-2 w-72 space-y-1 text-sm"></div>
          </div>
          <div class="space-y-3">
            <div>
              <label class="text-xs font-bold text-[#7d6c5c] uppercase block mb-1">Tipo (para las nuevas)</label>
              <select id="bulk-listing" class="px-3 py-2 rounded-xl border border-[#fff1e6] w-56">
                <option value="free">Gratuita</option><option value="gold_special" selected>Clásica</option><option value="gold_pro">Premium</option>
              </select>
              <p class="text-[11px] text-[#7d6c5c] mt-1">Después podés subirla a Premium desde ML.</p>
            </div>
            <label class="text-sm flex items-center gap-2"><input type="checkbox" id="bulk-zero" /> Incluir productos sin stock</label>
            <button id="btn-bulk-plan" class="px-4 py-2 bg-[#241a0d] text-white rounded-xl font-bold">Previsualizar</button>
          </div>
        </div>
        <div id="bulk-plan-out" class="text-sm"></div>
      </section>

      <section class="bg-white rounded-2xl shadow-sm border border-[#fff1e6] p-6 text-sm text-[#7d6c5c]">
        <h2 class="text-base font-bold text-[#241a0d] mb-2">Estado de las fases</h2>
        <ul class="list-disc pl-5 space-y-1">
          <li><b>Fase 1 ✓</b> — Stock: vinculás publicaciones y cada venta descuenta el stock en ML.</li>
          <li><b>Fase 2 ✓</b> — Ventas: las órdenes de ML entran como venta con su costo real de Mercado Pago.</li>
          <li><b>Fase 3 ✓</b> — Publicás productos del sistema en ML (arriba).</li>
        </ul>
      </section>
    </div>
  `;
}
