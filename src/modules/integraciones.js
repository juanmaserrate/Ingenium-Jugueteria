// M\u00f3dulo de Integraciones: conectar/desconectar Tienda Nube, configurar modo
// de stock, ver log de sincronizaci\u00f3n.

import { api, ApiError, getApiBase, setApiBase, getToken } from '../core/api.js';
import { toast } from '../core/notifications.js';

export async function mount(el) {
  el.innerHTML = renderShell();

  const apiBaseInput = el.querySelector('#api-base');
  apiBaseInput.value = getApiBase();
  el.querySelector('#btn-save-base').addEventListener('click', () => {
    setApiBase(apiBaseInput.value.trim());
    toast('Backend URL guardada', 'success');
    refresh();
  });

  el.querySelector('#btn-connect').addEventListener('click', () => {
    window.location.href = `${getApiBase()}/api/integrations/tiendanube/authorize`;
  });

  el.querySelector('#btn-disconnect').addEventListener('click', async () => {
    if (!confirm('\u00bfDesconectar Tienda Nube?')) return;
    try {
      await api('/api/integrations/tiendanube/disconnect', { method: 'POST' });
      toast('Desconectado de Tienda Nube', 'success');
      refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  el.querySelector('#stock-mode').addEventListener('change', async (e) => {
    try {
      await api('/api/integrations/tiendanube/settings', {
        method: 'PATCH',
        body: { stockMode: e.target.value },
      });
      toast('Modo de stock actualizado', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  async function refresh() {
    try {
      const status = await api('/api/integrations/status');
      const badge = status.connected
        ? '<span class="px-2 py-0.5 rounded-full bg-green-100 text-green-800 text-xs font-bold">Conectado</span>'
        : '<span class="px-2 py-0.5 rounded-full bg-gray-200 text-gray-700 text-xs font-bold">Desconectado</span>';
      el.querySelector('#status-badge').innerHTML = badge;
      el.querySelector('#tn-store-id').textContent = status.tnStoreId ?? '-';
      el.querySelector('#tn-connected-at').textContent = status.connectedAt
        ? new Date(status.connectedAt).toLocaleString('es-AR')
        : '-';
      el.querySelector('#tn-last-sync').textContent = status.lastSyncAt
        ? new Date(status.lastSyncAt).toLocaleString('es-AR')
        : '-';
      el.querySelector('#stock-mode').value = status.stockMode ?? 'sum';
      el.querySelector('#btn-connect').classList.toggle('hidden', status.connected);
      el.querySelector('#btn-disconnect').classList.toggle('hidden', !status.connected);
      el.querySelector('#settings-box').classList.toggle('hidden', !status.connected);

      if (status.connected) {
        await loadSyncLog();
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 0) {
        el.querySelector('#status-badge').innerHTML =
          '<span class="px-2 py-0.5 rounded-full bg-red-100 text-red-800 text-xs font-bold">Backend offline</span>';
      } else {
        toast(err.message, 'error');
      }
    }
  }

  async function loadSyncLog() {
    try {
      const log = await api('/api/sync/log?limit=30');
      const rows = log
        .map(
          (l) => `
        <tr class="border-b border-[#fff1e6]">
          <td class="py-1 px-2 text-xs">${new Date(l.datetime).toLocaleString('es-AR')}</td>
          <td class="py-1 px-2 text-xs font-mono">${l.operation}</td>
          <td class="py-1 px-2 text-xs">${l.entity}</td>
          <td class="py-1 px-2 text-xs">${badge(l.status)}</td>
          <td class="py-1 px-2 text-xs text-red-700">${l.error ?? ''}</td>
        </tr>
      `,
        )
        .join('');
      el.querySelector('#sync-log tbody').innerHTML =
        rows || '<tr><td colspan="5" class="py-4 text-center text-sm text-[#7d6c5c]">Sin actividad</td></tr>';
    } catch (err) {
      console.error(err);
    }
  }

  function badge(status) {
    const colors = {
      success: 'bg-green-100 text-green-800',
      error: 'bg-red-100 text-red-800',
      retry: 'bg-yellow-100 text-yellow-800',
    };
    return `<span class="px-1.5 py-0.5 rounded text-[10px] font-bold ${colors[status] ?? 'bg-gray-100'}">${status}</span>`;
  }

  // Avisar si no hay token
  if (!getToken()) {
    toast('Necesit\u00e1s iniciar sesi\u00f3n en el backend para usar esta secci\u00f3n', 'warning');
  }

  await refresh();
}

function renderShell() {
  return `
    <div class="max-w-5xl mx-auto space-y-6">
      <header>
        <h1 class="text-3xl font-black text-[#241a0d]">Integraciones</h1>
        <p class="text-[#7d6c5c] text-sm">Conect\u00e1 tu sistema con Tienda Nube para sincronizar productos, stock y ventas.</p>
      </header>

      <section class="bg-white rounded-2xl shadow-sm border border-[#fff1e6] p-6 space-y-4">
        <h2 class="text-lg font-bold">Backend</h2>
        <div class="flex items-center gap-3">
          <input id="api-base" class="flex-1 px-4 py-2 rounded-xl border border-[#fff1e6]" placeholder="http://localhost:3000" />
          <button id="btn-save-base" class="px-4 py-2 bg-[#d82f1e] text-white rounded-xl font-bold">Guardar</button>
        </div>
        <p class="text-xs text-[#7d6c5c]">URL del backend Ingenium (donde se instal\u00f3 con Docker/Railway).</p>
      </section>

      <section class="bg-white rounded-2xl shadow-sm border border-[#fff1e6] p-6 space-y-4">
        <div class="flex items-center justify-between">
          <div>
            <h2 class="text-lg font-bold flex items-center gap-3">
              Tienda Nube <span id="status-badge"></span>
            </h2>
            <p class="text-xs text-[#7d6c5c]">Sincroniza productos, stock y ventas autom\u00e1ticamente.</p>
          </div>
          <div>
            <button id="btn-connect" class="px-4 py-2 bg-[#d82f1e] text-white rounded-xl font-bold flex items-center gap-2 hidden">
              <span class="material-symbols-outlined text-base">link</span>
              Conectar
            </button>
            <button id="btn-disconnect" class="px-4 py-2 bg-gray-200 text-[#241a0d] rounded-xl font-bold hidden">
              Desconectar
            </button>
          </div>
        </div>
        <div class="grid grid-cols-3 gap-4 text-sm">
          <div><span class="text-[#7d6c5c] text-xs uppercase">Store ID</span><br/><span id="tn-store-id" class="font-mono"></span></div>
          <div><span class="text-[#7d6c5c] text-xs uppercase">Conectado</span><br/><span id="tn-connected-at"></span></div>
          <div><span class="text-[#7d6c5c] text-xs uppercase">\u00daltima sync</span><br/><span id="tn-last-sync"></span></div>
        </div>
      </section>

      <section id="settings-box" class="bg-white rounded-2xl shadow-sm border border-[#fff1e6] p-6 space-y-4 hidden">
        <h2 class="text-lg font-bold">Configuraci\u00f3n de stock en Tienda Nube</h2>
        <p class="text-sm text-[#7d6c5c]">El stock publicado en TN se calcula a partir de estas opciones:</p>
        <select id="stock-mode" class="px-4 py-2 rounded-xl border border-[#fff1e6]">
          <option value="sum">Suma de todas las sucursales (qty - reservado)</option>
          <option value="lomas">Solo Lomas</option>
          <option value="banfield">Solo Banfield</option>
        </select>
      </section>

      <section id="sync-log-section" class="bg-white rounded-2xl shadow-sm border border-[#fff1e6] p-6">
        <h2 class="text-lg font-bold mb-3">Actividad de sincronizaci\u00f3n</h2>
        <table id="sync-log" class="w-full">
          <thead>
            <tr class="text-left text-xs text-[#7d6c5c] uppercase">
              <th class="py-2 px-2">Fecha</th>
              <th class="py-2 px-2">Operaci\u00f3n</th>
              <th class="py-2 px-2">Entidad</th>
              <th class="py-2 px-2">Estado</th>
              <th class="py-2 px-2">Error</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </section>
    </div>
  `;
}
