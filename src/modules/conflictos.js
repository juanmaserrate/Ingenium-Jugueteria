// M\u00f3dulo Conflictos de sync: ventas offline que colisionaron con el stock al sincronizar,
// o duplicados, etc. El usuario resuelve manualmente.

import { api, ApiError } from '../core/api.js';
import { toast } from '../core/notifications.js';
import { listQueue, flushQueue } from '../core/sync-queue.js';

export async function mount(el) {
  el.innerHTML = renderShell();

  el.querySelector('#btn-flush').addEventListener('click', async () => {
    await flushQueue();
    await refresh();
  });

  async function refresh() {
    try {
      const [conflicts, localQueue] = await Promise.all([
        api('/api/sync/conflicts?status=open').catch((e) => {
          if (e instanceof ApiError && e.status === 0) return [];
          throw e;
        }),
        listQueue(),
      ]);

      const conflictItems = localQueue.filter((i) => i.conflict);
      el.querySelector('#conflict-count').textContent = conflicts.length + conflictItems.length;
      el.querySelector('#queue-count').textContent = localQueue.length;

      // Conflictos del backend
      const backendList = el.querySelector('#backend-conflicts');
      if (conflicts.length === 0 && conflictItems.length === 0) {
        backendList.innerHTML = '<div class="text-center py-8 text-[#7d6c5c]">Sin conflictos pendientes \ud83c\udf89</div>';
      } else {
        const rows = conflicts
          .map(
            (c) => `
          <div class="bg-white rounded-2xl shadow-sm border border-red-200 p-4 space-y-2">
            <div class="flex justify-between items-start">
              <div>
                <p class="font-bold">${c.type}</p>
                <p class="text-xs text-[#7d6c5c]">${new Date(c.createdAt).toLocaleString('es-AR')}</p>
              </div>
              <div class="flex gap-2">
                <button data-id="${c.id}" data-res="accept" class="btn-resolve px-3 py-1.5 rounded-lg bg-[#d82f1e] text-white text-xs font-bold">Aceptar</button>
                <button data-id="${c.id}" data-res="cancel" class="btn-resolve px-3 py-1.5 rounded-lg bg-gray-200 text-xs font-bold">Cancelar</button>
                <button data-id="${c.id}" data-res="adjust" class="btn-resolve px-3 py-1.5 rounded-lg bg-yellow-200 text-xs font-bold">Ajustar</button>
                <button data-id="${c.id}" class="btn-dismiss px-3 py-1.5 rounded-lg bg-white border text-xs">Descartar</button>
              </div>
            </div>
            <pre class="text-xs bg-[#fff8f4] p-2 rounded overflow-x-auto">${JSON.stringify(c.payload, null, 2)}</pre>
          </div>
        `,
          )
          .join('');

        const local = conflictItems
          .map(
            (i) => `
          <div class="bg-white rounded-2xl shadow-sm border border-yellow-300 p-4 space-y-2">
            <div class="flex justify-between items-start">
              <div>
                <p class="font-bold">Venta offline con conflicto</p>
                <p class="text-xs text-[#7d6c5c]">${i.createdAt} \u00b7 intentos: ${i.attempts}</p>
                <p class="text-sm text-red-700">${i.lastError ?? ''}</p>
              </div>
              <div class="flex gap-2">
                <button data-id="${i.id}" class="btn-retry-local px-3 py-1.5 rounded-lg bg-[#d82f1e] text-white text-xs font-bold">Reintentar</button>
              </div>
            </div>
            <pre class="text-xs bg-[#fff8f4] p-2 rounded overflow-x-auto">${JSON.stringify(i.payload, null, 2)}</pre>
          </div>
        `,
          )
          .join('');

        backendList.innerHTML = rows + local;

        backendList.querySelectorAll('.btn-resolve').forEach((b) => {
          b.addEventListener('click', () => resolve(b.dataset.id, b.dataset.res));
        });
        backendList.querySelectorAll('.btn-dismiss').forEach((b) => {
          b.addEventListener('click', () => dismiss(b.dataset.id));
        });
        backendList.querySelectorAll('.btn-retry-local').forEach((b) => {
          b.addEventListener('click', async () => {
            await flushQueue();
            await refresh();
          });
        });
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function resolve(id, resolution) {
    try {
      await api(`/api/sync/conflicts/${id}/resolve`, {
        method: 'POST',
        body: { resolution },
      });
      toast('Conflicto resuelto', 'success');
      refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function dismiss(id) {
    try {
      await api(`/api/sync/conflicts/${id}/dismiss`, { method: 'POST' });
      refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  await refresh();
  const interval = setInterval(refresh, 15_000);
  return () => clearInterval(interval);
}

function renderShell() {
  return `
    <div class="max-w-5xl mx-auto space-y-6">
      <header class="flex items-center justify-between">
        <div>
          <h1 class="text-3xl font-black text-[#241a0d]">Conflictos de sincronizaci\u00f3n</h1>
          <p class="text-[#7d6c5c] text-sm">Ventas u operaciones offline que necesitan tu decisi\u00f3n para sincronizar.</p>
        </div>
        <button id="btn-flush" class="px-4 py-2 bg-[#d82f1e] text-white rounded-xl font-bold flex items-center gap-2">
          <span class="material-symbols-outlined text-base">sync</span>
          Forzar sync
        </button>
      </header>

      <div class="grid grid-cols-2 gap-4">
        <div class="bg-white rounded-2xl p-4 border border-[#fff1e6]">
          <p class="text-xs text-[#7d6c5c] uppercase">Conflictos</p>
          <p id="conflict-count" class="text-3xl font-black">-</p>
        </div>
        <div class="bg-white rounded-2xl p-4 border border-[#fff1e6]">
          <p class="text-xs text-[#7d6c5c] uppercase">Cola local</p>
          <p id="queue-count" class="text-3xl font-black">-</p>
        </div>
      </div>

      <div id="backend-conflicts" class="space-y-3"></div>
    </div>
  `;
}
