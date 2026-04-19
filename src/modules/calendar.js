// Calendario — mensual grande con vencimientos de cheques, cumpleaños, fechas especiales y eventos editables.

import { getAll, put, del, newId } from '../core/db.js';
import { money, fmtDate, monthKey } from '../core/format.js';
import { openModal, confirmModal } from '../components/modal.js';
import { toast } from '../core/notifications.js';
import * as Audit from '../core/audit.js';
import { emptyState } from '../components/empty-state.js';

const state = {
  cursor: new Date(),
  selectedDay: null,
};

const FIXED_DATES = [
  { m: 1, d: 1,  t: 'Año nuevo', type: 'holiday' },
  { m: 2, d: 14, t: 'San Valentín', type: 'season' },
  { m: 3, d: 24, t: 'Memoria', type: 'holiday' },
  { m: 4, d: 2,  t: 'Malvinas', type: 'holiday' },
  { m: 5, d: 1,  t: 'Día del Trabajador', type: 'holiday' },
  { m: 5, d: 25, t: 'Revolución de Mayo', type: 'holiday' },
  { m: 6, d: 20, t: 'Día de la Bandera', type: 'holiday' },
  { m: 7, d: 9,  t: 'Día de la Independencia', type: 'holiday' },
  { m: 8, d: 20, t: 'Día del Niño', type: 'season' },
  { m: 10, d: 31, t: 'Halloween', type: 'season' },
  { m: 11, d: 20, t: 'Soberanía', type: 'holiday' },
  { m: 12, d: 8, t: 'Inmaculada', type: 'holiday' },
  { m: 12, d: 25, t: 'Navidad', type: 'holiday' },
  { m: 12, d: 31, t: 'Fin de año', type: 'season' },
];

export async function mount(el) { await render(el); }

async function render(el) {
  const [events, customers, checks] = await Promise.all([getAll('calendar_events'), getAll('customers'), getAll('checks')]);
  const y = state.cursor.getFullYear();
  const m = state.cursor.getMonth() + 1;
  const monthLabel = state.cursor.toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });

  const daysInMonth = new Date(y, m, 0).getDate();
  const firstDow = new Date(y, m - 1, 1).getDay();
  const dayOffset = firstDow === 0 ? 6 : firstDow - 1; // semana empieza en lunes

  // Indexar eventos por fecha
  const byDay = {};
  const push = (date, ev) => { (byDay[date] = byDay[date] || []).push(ev); };
  for (const e of events) push(e.date_from.slice(0, 10), { ...e, category: 'event' });
  // Cumpleaños de clientes
  for (const c of customers) {
    if (!c.birthday) continue;
    const parts = c.birthday.split('-');
    const bdKey = `${y}-${parts[1]}-${parts[2]}`;
    push(bdKey, { id: 'bd_' + c.id, title: `🎂 ${c.name} ${c.lastname || ''}`, category: 'birthday' });
  }
  // Cheques que vencen
  for (const ch of checks) {
    if (ch.status !== 'pending' || !ch.due_at) continue;
    push(ch.due_at.slice(0, 10), { id: 'chk_' + ch.id, title: `💳 Cheque #${ch.number} · ${money(ch.amount)}`, category: 'check' });
  }
  // Fechas fijas
  for (const f of FIXED_DATES) {
    const key = `${y}-${String(f.m).padStart(2, '0')}-${String(f.d).padStart(2, '0')}`;
    push(key, { id: 'fix_' + key, title: f.t, category: f.type });
  }

  el.innerHTML = `
    <div class="mb-6 flex justify-between items-center">
      <div>
        <h1 class="text-3xl font-black text-[#241a0d]">Calendario</h1>
        <p class="text-sm text-[#7d6c5c] mt-1">Cumpleaños · Vencimientos · Fechas especiales</p>
      </div>
      <div class="flex items-center gap-2">
        <button id="cal-prev" class="w-10 h-10 rounded-xl bg-[#fff1e6] hover:bg-[#d82f1e] hover:text-white flex items-center justify-center"><span class="material-symbols-outlined">chevron_left</span></button>
        <div class="font-black text-xl text-[#241a0d] capitalize w-48 text-center">${monthLabel}</div>
        <button id="cal-next" class="w-10 h-10 rounded-xl bg-[#fff1e6] hover:bg-[#d82f1e] hover:text-white flex items-center justify-center"><span class="material-symbols-outlined">chevron_right</span></button>
        <button id="cal-today" class="ing-btn-secondary text-sm">Hoy</button>
        <button id="cal-new" class="ing-btn-primary flex items-center gap-2"><span class="material-symbols-outlined text-base">add</span> Nuevo evento</button>
      </div>
    </div>

    <div class="ing-card p-4">
      <div class="grid grid-cols-7 gap-1 text-center text-xs font-black text-[#7d6c5c] uppercase mb-1">
        ${['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'].map(d => `<div>${d}</div>`).join('')}
      </div>
      <div class="grid grid-cols-7 gap-1">
        ${Array.from({length: dayOffset}).map(() => `<div class="h-28 bg-[#fff8f4]/30 rounded-lg"></div>`).join('')}
        ${Array.from({length: daysInMonth}, (_, i) => {
          const day = i + 1;
          const key = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          const evs = byDay[key] || [];
          const today = new Date().toISOString().slice(0, 10) === key;
          return `
            <div data-day="${key}" class="h-28 rounded-lg p-1.5 cursor-pointer border hover:border-[#d82f1e] ${today ? 'bg-[#fff1e6] border-[#d82f1e]' : 'bg-white border-[#fff1e6]'}">
              <div class="flex justify-between items-center">
                <div class="text-xs font-bold ${today ? 'text-[#d82f1e]' : 'text-[#241a0d]'}">${day}</div>
                ${evs.length ? `<div class="text-[9px] bg-[#d82f1e] text-white rounded-full px-1.5 font-bold">${evs.length}</div>` : ''}
              </div>
              <div class="mt-1 space-y-0.5 overflow-hidden">
                ${evs.slice(0, 3).map(e => {
                  const bg = { birthday: 'bg-pink-100 text-pink-700', check: 'bg-red-100 text-red-700', holiday: 'bg-blue-100 text-blue-700', season: 'bg-amber-100 text-amber-700', event: 'bg-green-100 text-green-700' }[e.category] || 'bg-gray-100';
                  return `<div class="text-[10px] px-1 py-0.5 rounded truncate ${bg}">${e.title}</div>`;
                }).join('')}
                ${evs.length > 3 ? `<div class="text-[9px] text-[#7d6c5c] font-bold">+${evs.length - 3}</div>` : ''}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;

  el.querySelector('#cal-prev').addEventListener('click', () => { state.cursor = new Date(y, m - 2, 1); render(el); });
  el.querySelector('#cal-next').addEventListener('click', () => { state.cursor = new Date(y, m, 1); render(el); });
  el.querySelector('#cal-today').addEventListener('click', () => { state.cursor = new Date(); render(el); });
  el.querySelector('#cal-new').addEventListener('click', () => editEvent(el, null));
  el.querySelectorAll('[data-day]').forEach(d => d.addEventListener('click', () => openDay(el, d.dataset.day, byDay[d.dataset.day] || [])));
}

async function openDay(root, date, events) {
  await openModal({
    title: `Eventos · ${fmtDate(date)}`,
    size: 'md',
    bodyHTML: `
      ${events.length ? `
        <div class="space-y-2 mb-4">
          ${events.map(e => {
            const bg = { birthday: 'bg-pink-50', check: 'bg-red-50', holiday: 'bg-blue-50', season: 'bg-amber-50', event: 'bg-green-50' }[e.category] || 'bg-[#fff8f4]';
            return `
              <div class="${bg} rounded-xl p-3 flex justify-between items-center">
                <div>
                  <div class="font-bold">${e.title}</div>
                  ${e.description ? `<div class="text-xs text-[#7d6c5c]">${e.description}</div>` : ''}
                </div>
                ${e.category === 'event' ? `<div class="flex gap-1"><button data-ed="${e.id}" class="text-xs text-[#d82f1e]">Editar</button><button data-de="${e.id}" class="text-xs text-red-600 ml-2">Borrar</button></div>` : ''}
              </div>
            `;
          }).join('')}
        </div>
      ` : emptyState({ icon: 'event', title: 'Sin eventos', hint: 'Agregá un evento, recordatorio o nota para este día.', compact: true })}
      <button id="day-add" class="ing-btn-primary w-full flex items-center justify-center gap-2"><span class="material-symbols-outlined">add</span> Agregar evento este día</button>
    `,
    footerHTML: `<button class="ing-btn-secondary" data-act="close">Cerrar</button>`,
    onOpen: (m, close) => {
      m.querySelector('[data-act="close"]').addEventListener('click', () => close(false));
      m.querySelector('#day-add').addEventListener('click', async () => { close(true); editEvent(root, null, date); });
      m.querySelectorAll('[data-ed]').forEach(b => b.addEventListener('click', async () => {
        const all = await getAll('calendar_events'); const ev = all.find(x => x.id === b.dataset.ed); if (ev) { close(true); editEvent(root, ev); }
      }));
      m.querySelectorAll('[data-de]').forEach(b => b.addEventListener('click', async () => {
        const ok = await confirmModal({ title: 'Borrar', message: '¿Eliminar evento?', danger: true, confirmLabel: 'Borrar' });
        if (!ok) return;
        await del('calendar_events', b.dataset.de);
        await Audit.log({ action: 'delete', entity: 'evento', entity_id: b.dataset.de, description: 'Evento eliminado' });
        toast('Eliminado', 'success'); close(true); render(root);
      }));
    },
  });
}

async function editEvent(root, existing, defaultDate = null) {
  const isNew = !existing;
  const e = existing || { id: newId('evt'), title: '', description: '', date_from: defaultDate || new Date().toISOString().slice(0, 10), date_to: defaultDate || new Date().toISOString().slice(0, 10), color: '#d82f1e' };
  await openModal({
    title: isNew ? 'Nuevo evento' : 'Editar evento',
    size: 'md',
    bodyHTML: `
      <div class="space-y-3">
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Título *</label><input id="ev-title" value="${e.title||''}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Descripción</label><textarea id="ev-desc" rows="2" class="ing-input w-full mt-1">${e.description||''}</textarea></div>
        <div class="grid grid-cols-2 gap-3">
          <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Desde</label><input id="ev-from" type="date" value="${e.date_from?.slice(0,10) || ''}" class="ing-input w-full mt-1" /></div>
          <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Hasta</label><input id="ev-to" type="date" value="${e.date_to?.slice(0,10) || ''}" class="ing-input w-full mt-1" /></div>
        </div>
      </div>
    `,
    footerHTML: `<button class="ing-btn-secondary" data-act="cancel">Cancelar</button><button class="ing-btn-primary" data-act="ok">${isNew?'Crear':'Guardar'}</button>`,
    onOpen: (m, close) => {
      m.querySelector('[data-act="cancel"]').addEventListener('click', () => close(false));
      m.querySelector('[data-act="ok"]').addEventListener('click', async () => {
        e.title = m.querySelector('#ev-title').value.trim();
        if (!e.title) { toast('Título requerido', 'warn'); return; }
        e.description = m.querySelector('#ev-desc').value;
        e.date_from = m.querySelector('#ev-from').value;
        e.date_to = m.querySelector('#ev-to').value || e.date_from;
        await put('calendar_events', e);
        await Audit.log({ action: isNew?'create':'update', entity: 'evento', entity_id: e.id, after: e, description: e.title });
        toast(isNew?'Creado':'Guardado', 'success'); close(true);
      });
    },
  });
  render(root);
}
