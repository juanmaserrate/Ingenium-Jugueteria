// Historial — registro de auditoría del servidor (consolidado), con filtros y export.

import { api } from '../core/api.js';
import { fmtDateTime, todayKey } from '../core/format.js';
import { exportSimple } from '../core/xlsx.js';
import { toast } from '../core/notifications.js';
import { loadFilter, saveFilter } from '../core/filter-state.js';

const AR = '-03:00';
const state = loadFilter('history', { action: '', entity: '', search: '', from: '', to: '' });

export async function mount(el) { await render(el); }

async function render(el) {
  let rows;
  try {
    const qs = new URLSearchParams();
    if (state.action) qs.set('action', state.action);
    if (state.entity) qs.set('entity', state.entity);
    if (state.search) qs.set('q', state.search);
    if (state.from) qs.set('from', new Date(`${state.from}T00:00:00${AR}`).toISOString());
    if (state.to) qs.set('to', new Date(new Date(`${state.to}T00:00:00${AR}`).getTime() + 86400000).toISOString());
    rows = await api(`/api/audit?${qs.toString()}`);
  } catch {
    el.innerHTML = `<div class="mb-6"><h1 class="text-3xl font-black text-[#241a0d]">Historial de Acciones</h1></div>
      <div class="ing-card p-6 text-center"><span class="material-symbols-outlined text-4xl text-amber-500">cloud_off</span>
      <p class="mt-2 font-bold">Sin conexión</p><p class="text-sm text-[#7d6c5c]">El historial necesita internet. El POS y la caja funcionan normalmente.</p></div>`;
    return;
  }

  const actions = [...new Set(rows.map(e => e.action))];
  const entities = [...new Set(rows.map(e => e.entity))];

  el.innerHTML = `
    <div class="mb-6 flex justify-between items-center">
      <div>
        <h1 class="text-3xl font-black text-[#241a0d]">Historial de Acciones</h1>
        <p class="text-sm text-[#7d6c5c] mt-1">${rows.length} registros (consolidado · todas las sucursales)</p>
      </div>
      <button id="h-export" class="ing-btn-secondary flex items-center gap-2"><span class="material-symbols-outlined text-base">download</span> XLSX</button>
    </div>

    <div class="ing-card p-3 mb-4">
      <div class="grid grid-cols-6 gap-2">
        <input id="f-search" placeholder="Buscar…" value="${state.search}" class="ing-input col-span-2" />
        <select id="f-action" class="ing-input"><option value="">Todas acciones</option>${actions.map(a => `<option value="${a}" ${state.action===a?'selected':''}>${a}</option>`).join('')}</select>
        <select id="f-entity" class="ing-input"><option value="">Todas entidades</option>${entities.map(e => `<option value="${e}" ${state.entity===e?'selected':''}>${e}</option>`).join('')}</select>
        <input id="f-from" type="date" value="${state.from}" class="ing-input" placeholder="Desde" />
        <input id="f-to" type="date" value="${state.to}" class="ing-input" placeholder="Hasta" />
      </div>
    </div>

    <div class="ing-card overflow-hidden">
      <table class="ing-table w-full">
        <thead><tr><th>Fecha</th><th>Usuario</th><th>Acción</th><th>Entidad</th><th>Descripción</th></tr></thead>
        <tbody>
          ${rows.length ? rows.map(e => `
            <tr>
              <td class="text-xs">${fmtDateTime(e.datetime)}</td>
              <td class="font-bold text-sm">${e.userName || '—'}</td>
              <td><span class="px-2 py-0.5 rounded-full bg-[#fff1e6] text-[#d82f1e] text-[10px] font-black uppercase">${e.action}</span></td>
              <td class="text-xs">${e.entity}</td>
              <td class="text-sm">${e.description || '-'}</td>
            </tr>
          `).join('') : `<tr><td colspan="5" class="text-center py-8 text-[#7d6c5c]">Sin resultados</td></tr>`}
        </tbody>
      </table>
      ${rows.length >= 500 ? `<div class="px-4 py-2 text-xs text-[#7d6c5c] bg-[#fff8f4]">Mostrando primeros 500 · Usá filtros para acotar</div>` : ''}
    </div>
  `;

  const savedRender = () => { saveFilter('history', state); render(el); };
  let searchTimer;
  el.querySelector('#f-search').addEventListener('input', (ev) => { state.search = ev.target.value; clearTimeout(searchTimer); searchTimer = setTimeout(savedRender, 350); });
  el.querySelector('#f-action').addEventListener('change', (ev) => { state.action = ev.target.value; savedRender(); });
  el.querySelector('#f-entity').addEventListener('change', (ev) => { state.entity = ev.target.value; savedRender(); });
  el.querySelector('#f-from').addEventListener('change', (ev) => { state.from = ev.target.value; savedRender(); });
  el.querySelector('#f-to').addEventListener('change', (ev) => { state.to = ev.target.value; savedRender(); });
  el.querySelector('#h-export').addEventListener('click', () => {
    exportSimple(`auditoria_${todayKey()}.xlsx`, rows.map(e => ({
      Fecha: fmtDateTime(e.datetime), Usuario: e.userName || '', Accion: e.action,
      Entidad: e.entity, EntidadId: e.entityId || '', Descripcion: e.description || '',
    })), 'Auditoría');
    toast('Exportado', 'success');
  });
}
