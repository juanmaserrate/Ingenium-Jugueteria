// Historial — registro de auditoría con filtros, búsqueda y export.

import * as Audit from '../core/audit.js';
import { fmtDateTime, todayKey } from '../core/format.js';
import { exportSimple } from '../core/xlsx.js';
import { toast } from '../core/notifications.js';
import { loadFilter, saveFilter } from '../core/filter-state.js';

const state = loadFilter('history', {
  action: '',
  entity: '',
  user: '',
  search: '',
  from: '',
  to: '',
});

export async function mount(el) { await render(el); }

async function render(el) {
  const all = await Audit.list();
  const filtered = all.filter(e => {
    if (state.action && e.action !== state.action) return false;
    if (state.entity && e.entity !== state.entity) return false;
    if (state.user && e.user_id !== state.user) return false;
    if (state.from && e.datetime < state.from) return false;
    if (state.to && e.datetime > state.to + 'T23:59:59') return false;
    if (state.search) {
      const q = state.search.toLowerCase();
      if (!((e.description || '').toLowerCase().includes(q) || (e.user_name || '').toLowerCase().includes(q) || (e.entity_id || '').toLowerCase().includes(q))) return false;
    }
    return true;
  });

  const actions = [...new Set(all.map(e => e.action))];
  const entities = [...new Set(all.map(e => e.entity))];
  const users = [...new Set(all.map(e => e.user_id).filter(Boolean))];
  const userNames = {};
  all.forEach(e => { if (e.user_id && !userNames[e.user_id]) userNames[e.user_id] = e.user_name || e.user_id; });

  el.innerHTML = `
    <div class="mb-6 flex justify-between items-center">
      <div>
        <h1 class="text-3xl font-black text-[#241a0d]">Historial de Acciones</h1>
        <p class="text-sm text-[#7d6c5c] mt-1">${filtered.length} de ${all.length} registros</p>
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
          ${filtered.length ? filtered.slice(0, 500).map(e => `
            <tr>
              <td class="text-xs">${fmtDateTime(e.datetime)}</td>
              <td class="font-bold text-sm">${e.user_name || '—'}</td>
              <td><span class="px-2 py-0.5 rounded-full bg-[#fff1e6] text-[#d82f1e] text-[10px] font-black uppercase">${e.action}</span></td>
              <td class="text-xs">${e.entity}</td>
              <td class="text-sm">${e.description || '-'}</td>
            </tr>
          `).join('') : `<tr><td colspan="5" class="text-center py-8 text-[#7d6c5c]">Sin resultados</td></tr>`}
        </tbody>
      </table>
      ${filtered.length > 500 ? `<div class="px-4 py-2 text-xs text-[#7d6c5c] bg-[#fff8f4]">Mostrando primeros 500 · Usá filtros para acotar</div>` : ''}
    </div>
  `;

  const savedRender = () => { saveFilter('history', state); render(el); };
  el.querySelector('#f-search').addEventListener('input', (ev) => { state.search = ev.target.value; savedRender(); });
  el.querySelector('#f-action').addEventListener('change', (ev) => { state.action = ev.target.value; savedRender(); });
  el.querySelector('#f-entity').addEventListener('change', (ev) => { state.entity = ev.target.value; savedRender(); });
  el.querySelector('#f-from').addEventListener('change', (ev) => { state.from = ev.target.value; savedRender(); });
  el.querySelector('#f-to').addEventListener('change', (ev) => { state.to = ev.target.value; savedRender(); });
  el.querySelector('#h-export').addEventListener('click', () => {
    exportSimple(`auditoria_${todayKey()}.xlsx`, filtered.map(e => ({
      Fecha: fmtDateTime(e.datetime), Usuario: e.user_name || '', Accion: e.action,
      Entidad: e.entity, EntidadId: e.entity_id || '', Descripcion: e.description || '',
    })), 'Auditoría');
    toast('Exportado', 'success');
  });
}
