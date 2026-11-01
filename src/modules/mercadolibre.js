// Módulo Mercado Libre: conectar/desconectar la cuenta, ver estado del token y probar la
// conexión. Fase 0 (fundaciones). El resto (stock, órdenes, publicar) se agrega por fases.

import { api, ApiError, getApiBase, getToken } from '../core/api.js';
import { toast } from '../core/notifications.js';

export async function mount(el) {
  el.innerHTML = renderShell();

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
    } catch (err) {
      if (err instanceof ApiError && err.status === 0) {
        el.querySelector('#status-badge').innerHTML = '<span class="px-2 py-0.5 rounded-full bg-red-100 text-red-800 text-xs font-bold">Backend offline</span>';
      } else { toast(err.message, 'error'); }
    }
  }

  if (!getToken()) toast('Necesitás iniciar sesión para usar esta sección', 'warning');
  await refresh();
}

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

      <section class="bg-white rounded-2xl shadow-sm border border-[#fff1e6] p-6 text-sm text-[#7d6c5c]">
        <h2 class="text-base font-bold text-[#241a0d] mb-2">Próximas fases</h2>
        <ul class="list-disc pl-5 space-y-1">
          <li><b>Fase 1</b> — Stock: enlazar publicaciones y que nunca sobrevendas.</li>
          <li><b>Fase 2</b> — Ventas: las órdenes de ML entran como venta con su costo real de Mercado Pago.</li>
          <li><b>Fase 3</b> — Publicar/editar publicaciones desde el inventario.</li>
        </ul>
      </section>
    </div>
  `;
}
