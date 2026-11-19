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
      el.querySelector('#ml-publish-box').classList.toggle('hidden', !s.connected);
      el.querySelector('#ml-howto-box').classList.toggle('hidden', !s.connected);
      el.querySelector('#ml-terms-box').classList.toggle('hidden', !s.connected);
      el.querySelector('#ml-catmap-box').classList.toggle('hidden', !s.connected);
      if (s.connected) { await loadMappings(); loadTermsCount(); loadCatMap(); }
    } catch (err) {
      if (err instanceof ApiError && err.status === 0) {
        el.querySelector('#status-badge').innerHTML = '<span class="px-2 py-0.5 rounded-full bg-red-100 text-red-800 text-xs font-bold">Backend offline</span>';
      } else { toast(err.message, 'error'); }
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

  // ---- Condiciones de la tienda: garantía 30 días + retiro en persona ----
  let linkedIds = [];
  async function loadTermsCount() {
    try {
      linkedIds = (await api('/api/integrations/ml/linked-items')).itemIds || [];
      el.querySelector('#terms-count').textContent = `${linkedIds.length} publicaciones vinculadas`;
    } catch { /* se reintenta al tocar el botón */ }
  }
  el.querySelector('#btn-terms-apply').addEventListener('click', async () => {
    const btn = el.querySelector('#btn-terms-apply');
    if (btn.disabled) return;
    await loadTermsCount();
    if (!linkedIds.length) { toast('No hay publicaciones vinculadas', 'info'); return; }
    if (!confirm(`Se va a poner garantía de 30 días y retiro en persona en ${linkedIds.length} publicaciones reales de Mercado Libre. ¿Confirmás?`)) return;
    btn.disabled = true; btn.textContent = 'Aplicando…';
    el.querySelector('#terms-progress').classList.remove('hidden');
    const log = el.querySelector('#terms-log'); log.innerHTML = '';
    const bar = el.querySelector('#terms-bar'); const sum = el.querySelector('#terms-summary');
    const tot = { done: 0, garantia: 0, retiro: 0, igual: 0, error: 0 };
    for (let i = 0; i < linkedIds.length; i += 8) {
      const chunk = linkedIds.slice(i, i + 8);
      try {
        const { results } = await api('/api/integrations/ml/apply-terms', { method: 'POST', body: { itemIds: chunk } });
        for (const r of results) {
          tot.done++;
          if (r.warranty === 'aplicada') tot.garantia++;
          if (r.pickup === 'aplicado') tot.retiro++;
          if (r.warranty === 'sin cambios' && r.pickup === 'sin cambios') tot.igual++;
          if (r.error) {
            tot.error++;
            const line = document.createElement('div');
            line.innerHTML = `<span class="text-red-600 font-bold">${esc(r.itemId)}</span> — garantía: ${esc(r.warranty)} · retiro: ${esc(r.pickup)} · <span class="text-[#7d6c5c]">${esc(r.error)}</span>`;
            log.prepend(line);
          }
        }
      } catch (err) {
        tot.done += chunk.length; tot.error += chunk.length;
        const line = document.createElement('div');
        line.innerHTML = `<span class="text-red-600 font-bold">Tanda con error</span> — ${esc(err.message)}`;
        log.prepend(line);
      }
      bar.style.width = Math.round((tot.done / linkedIds.length) * 100) + '%';
      sum.textContent = `${tot.done} de ${linkedIds.length} · garantía puesta en ${tot.garantia} · retiro puesto en ${tot.retiro} · ya estaban ${tot.igual} · con error ${tot.error}`;
    }
    btn.disabled = false; btn.textContent = 'Aplicar a las publicaciones vinculadas';
    toast(`Listo: garantía en ${tot.garantia}, retiro en ${tot.retiro}${tot.error ? `, ${tot.error} con error` : ''}`, tot.error ? 'warn' : 'success');
  });

  // ---- Mapeo de categorías del sistema → Mercado Libre ----
  let catRows = [];
  const catSuggest = {}; // id → candidatos de la última sugerencia
  function drawCatMap() {
    const body = el.querySelector('#catmap-body');
    if (!catRows.length) { body.innerHTML = '<tr><td colspan="4" class="py-6 text-center text-[#7d6c5c]">No hay categorías cargadas.</td></tr>'; return; }
    const mapped = catRows.filter((c) => c.mlCategoryId).length;
    el.querySelector('#catmap-status').textContent = `${mapped} de ${catRows.length} categorías mapeadas`;
    body.innerHTML = catRows.map((c) => {
      const cands = catSuggest[c.id];
      const candHtml = cands ? (cands.length
        ? `<div class="mt-1 flex flex-wrap gap-1">${cands.map((k) => `<button type="button" data-pick="${esc(c.id)}" data-cat="${esc(k.categoryId)}" class="px-2 py-0.5 rounded-full border border-[#e3ceba] hover:border-[#d82f1e] text-[11px]" title="${esc(k.categoryId)}">${esc(k.path)} <b>${Math.round(k.share * 100)}%</b></button>`).join('')}</div>`
        : '<div class="mt-1 text-[11px] text-amber-700">Mercado Libre no sugirió nada para estos productos.</div>') : '';
      return `<tr class="border-t border-[#fff1e6] align-top">
        <td class="py-2 px-2 font-bold">${esc(c.name)}</td>
        <td class="py-2 px-2 text-right">${c.products}</td>
        <td class="py-2 px-2">
          ${c.mlCategoryId
            ? `<div>${esc(c.mlCategoryName || c.mlCategoryId)} <span class="text-[11px] text-[#7d6c5c]">(${esc(c.mlCategoryId)})</span></div>`
            : '<div class="text-[#7d6c5c] italic">Sin mapear — se elige por el título de cada producto</div>'}
          ${candHtml}
        </td>
        <td class="py-2 px-2 text-right whitespace-nowrap">
          <button type="button" data-sug="${esc(c.id)}" class="text-xs font-bold text-[#d82f1e] hover:underline">Sugerir</button>
          <button type="button" data-manual="${esc(c.id)}" class="text-xs text-[#7d6c5c] hover:underline ml-2">Escribir código</button>
          ${c.mlCategoryId ? `<button type="button" data-clear="${esc(c.id)}" class="text-xs text-[#7d6c5c] hover:underline ml-2">Quitar</button>` : ''}
        </td>
      </tr>`;
    }).join('');
    body.querySelectorAll('[data-sug]').forEach((b) => b.addEventListener('click', async () => {
      b.textContent = 'Buscando…';
      try { catSuggest[b.dataset.sug] = (await api(`/api/integrations/ml/category-map/${encodeURIComponent(b.dataset.sug)}/suggest`, { method: 'POST', body: {} })).candidates || []; }
      catch (err) { toast(err.message, 'error'); }
      drawCatMap();
    }));
    body.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => saveCat(b.dataset.pick, b.dataset.cat)));
    body.querySelectorAll('[data-clear]').forEach((b) => b.addEventListener('click', () => saveCat(b.dataset.clear, null)));
    body.querySelectorAll('[data-manual]').forEach((b) => b.addEventListener('click', () => {
      const v = prompt('Código de la categoría de Mercado Libre (ej: MLA1234):');
      if (v && v.trim()) saveCat(b.dataset.manual, v.trim());
    }));
  }
  async function saveCat(id, mlCategoryId) {
    try {
      const r = await api(`/api/integrations/ml/category-map/${encodeURIComponent(id)}`, { method: 'PUT', body: { mlCategoryId } });
      const row = catRows.find((c) => c.id === id);
      if (row) { row.mlCategoryId = r.mlCategoryId; row.mlCategoryName = r.mlCategoryName; }
      delete catSuggest[id];
      drawCatMap();
    } catch (err) { toast(err.message, 'error'); }
  }
  async function loadCatMap() {
    try { catRows = await api('/api/integrations/ml/category-map'); drawCatMap(); }
    catch (err) { el.querySelector('#catmap-body').innerHTML = `<tr><td colspan="4" class="py-6 text-center text-red-600">${esc(err.message)}</td></tr>`; }
  }
  // Aprende de las publicaciones que ya existen en ML: para cada categoría del sistema mira en
  // qué categoría de ML están publicados sus productos. Guarda sola cuando es clara (≥60% y al
  // menos 3 publicaciones); el resto queda con las opciones a la vista para elegir.
  el.querySelector('#btn-catmap-listings').addEventListener('click', async () => {
    const btn = el.querySelector('#btn-catmap-listings');
    if (btn.disabled) return;
    btn.disabled = true; btn.textContent = 'Leyendo tus publicaciones… (30 s)';
    let saved = 0, doubt = 0;
    try {
      const r = await api('/api/integrations/ml/category-map/from-listings', { method: 'POST', body: {} });
      for (const c of (r.categories || [])) {
        const row = catRows.find((x) => x.id === c.categoryId);
        if (!row || row.mlCategoryId) continue;
        const top = c.candidates[0];
        if (top && top.share >= 0.6 && c.publicaciones >= 3) {
          try {
            const w = await api(`/api/integrations/ml/category-map/${encodeURIComponent(c.categoryId)}`, { method: 'PUT', body: { mlCategoryId: top.categoryId } });
            row.mlCategoryId = w.mlCategoryId; row.mlCategoryName = w.mlCategoryName; saved++;
          } catch { catSuggest[c.categoryId] = c.candidates; doubt++; }
        } else { catSuggest[c.categoryId] = c.candidates; doubt++; }
      }
      drawCatMap();
      toast(`Mapeadas ${saved} categorías desde tus publicaciones. ${doubt} quedaron con opciones para elegir.`, doubt ? 'warn' : 'success');
    } catch (err) { toast(err.message, 'error'); }
    btn.disabled = false; btn.textContent = 'Aprender de mis publicaciones';
  });

  // Sugiere todas las que faltan: guarda sola la propuesta cuando es clara (≥60% de los
  // productos probados caen en la misma categoría); las dudosas quedan con opciones para elegir.
  el.querySelector('#btn-catmap-all').addEventListener('click', async () => {
    const btn = el.querySelector('#btn-catmap-all');
    if (btn.disabled) return;
    const todo = catRows.filter((c) => !c.mlCategoryId && c.products > 0);
    if (!todo.length) { toast('No quedan categorías con productos sin mapear', 'info'); return; }
    btn.disabled = true;
    let saved = 0, doubt = 0, n = 0;
    for (const c of todo) {
      n++;
      btn.textContent = `Sugiriendo ${n}/${todo.length}…`;
      try {
        const r = await api(`/api/integrations/ml/category-map/${encodeURIComponent(c.id)}/suggest`, { method: 'POST', body: {} });
        const top = (r.candidates || [])[0];
        if (top && top.share >= 0.6) {
          const w = await api(`/api/integrations/ml/category-map/${encodeURIComponent(c.id)}`, { method: 'PUT', body: { mlCategoryId: top.categoryId } });
          c.mlCategoryId = w.mlCategoryId; c.mlCategoryName = w.mlCategoryName; saved++;
        } else { catSuggest[c.id] = r.candidates || []; doubt++; }
      } catch { catSuggest[c.id] = []; doubt++; }
      drawCatMap();
    }
    btn.disabled = false; btn.textContent = 'Sugerir las que faltan';
    toast(`Mapeadas ${saved} categorías. ${doubt} quedaron para que elijas.`, doubt ? 'warn' : 'success');
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

      <section id="ml-howto-box" class="hidden bg-white rounded-2xl shadow-sm border border-[#fff1e6] p-6 space-y-3">
        <h2 class="text-lg font-bold">¿Dónde se hace cada cosa?</h2>
        <div class="grid md:grid-cols-2 gap-3 text-sm">
          <a href="#/inventory" class="block border border-[#e3ceba] rounded-xl p-4 hover:border-[#d82f1e] hover:bg-[#fff8f4]">
            <div class="font-bold flex items-center gap-2"><span class="material-symbols-outlined text-[#d82f1e]">inventory_2</span> Publicar y vincular productos</div>
            <p class="text-xs text-[#7d6c5c] mt-1">En <b>Inventario</b>: seleccioná productos → "Publicar en Mercado Libre". Con "Sincronizar ML" vinculás lo que ya tenés publicado. La columna "Mercado Libre" muestra qué está vinculado.</p>
          </a>
          <a href="#/ventas-ml" class="block border border-[#e3ceba] rounded-xl p-4 hover:border-[#d82f1e] hover:bg-[#fff8f4]">
            <div class="font-bold flex items-center gap-2"><span class="material-symbols-outlined text-[#d82f1e]">local_mall</span> Cobrar las ventas de Mercado Libre</div>
            <p class="text-xs text-[#7d6c5c] mt-1">En <b>Ventas Mercado Libre</b>: cada venta entra sola; elegís la sucursal y se registra con su comisión real.</p>
          </a>
        </div>
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

      <section id="ml-terms-box" class="hidden bg-white rounded-2xl shadow-sm border border-[#fff1e6] p-6 space-y-3">
        <div>
          <h2 class="text-lg font-bold">Condiciones de venta de la tienda</h2>
          <p class="text-xs text-[#7d6c5c]">Todo lo que publiques desde el sistema sale con <b>garantía del vendedor de 30 días</b> y <b>retiro en persona</b>. Con este botón se lo aplicás también a las publicaciones que ya están vinculadas al inventario (no cambia precio, stock ni título).</p>
        </div>
        <div class="flex items-center gap-3 flex-wrap">
          <button id="btn-terms-apply" class="px-4 py-2 bg-[#241a0d] text-white rounded-xl font-bold">Aplicar a las publicaciones vinculadas</button>
          <span id="terms-count" class="text-xs text-[#7d6c5c]"></span>
        </div>
        <div id="terms-progress" class="hidden">
          <div class="h-2 bg-[#fff1e6] rounded-full overflow-hidden"><div id="terms-bar" class="h-2 bg-[#d82f1e] rounded-full transition-all" style="width:0%"></div></div>
          <div id="terms-summary" class="text-xs text-[#7d6c5c] mt-1"></div>
        </div>
        <div id="terms-log" class="space-y-1 text-xs max-h-48 overflow-auto"></div>
      </section>

      <section id="ml-catmap-box" class="hidden bg-white rounded-2xl shadow-sm border border-[#fff1e6] p-6 space-y-3">
        <div class="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 class="text-lg font-bold">Categorías: sistema → Mercado Libre</h2>
            <p class="text-xs text-[#7d6c5c] max-w-2xl">Cada categoría del inventario se publica en la categoría de Mercado Libre que figura acá. "Sugerir" mira los productos de esa categoría y propone la que más coincide. Si una categoría queda sin mapear, Mercado Libre la elige por el título de cada producto.</p>
          </div>
          <div class="flex gap-2 flex-wrap">
            <button id="btn-catmap-listings" class="px-4 py-2 bg-[#d82f1e] text-white rounded-xl font-bold text-sm" title="Usa las categorías que ya eligieron en sus publicaciones de Mercado Libre">Aprender de mis publicaciones</button>
            <button id="btn-catmap-all" class="px-4 py-2 bg-[#241a0d] text-white rounded-xl font-bold text-sm">Sugerir las que faltan</button>
          </div>
        </div>
        <div id="catmap-status" class="text-xs text-[#7d6c5c]"></div>
        <div class="overflow-auto max-h-[28rem] border border-[#fff1e6] rounded-xl">
          <table class="w-full text-sm">
            <thead class="sticky top-0 bg-white"><tr class="text-left text-[10px] text-[#7d6c5c] uppercase">
              <th class="py-2 px-2">Categoría del sistema</th><th class="py-2 px-2 text-right">Productos</th><th class="py-2 px-2">Categoría en Mercado Libre</th><th class="py-2 px-2"></th>
            </tr></thead>
            <tbody id="catmap-body"><tr><td colspan="4" class="py-6 text-center text-[#7d6c5c]">Cargando…</td></tr></tbody>
          </table>
        </div>
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
