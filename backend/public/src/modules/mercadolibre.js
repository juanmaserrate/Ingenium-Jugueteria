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
      if (s.connected) { await loadOrders(); await loadMappings(); }
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

      <section class="bg-white rounded-2xl shadow-sm border border-[#fff1e6] p-6 text-sm text-[#7d6c5c]">
        <h2 class="text-base font-bold text-[#241a0d] mb-2">Próximas fases</h2>
        <ul class="list-disc pl-5 space-y-1">
          <li><b>Fase 1 ✓</b> — Stock: vinculás publicaciones y cada venta descuenta el stock en ML.</li>
          <li><b>Fase 2 ✓</b> — Ventas: las órdenes de ML entran como venta con su costo real de Mercado Pago (arriba).</li>
          <li><b>Fase 3</b> — Publicar/editar publicaciones desde el inventario.</li>
        </ul>
      </section>
    </div>
  `;
}
