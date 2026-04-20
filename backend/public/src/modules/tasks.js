// Tareas — Kanban Pendiente / En curso / Hecho con drag&drop, prioridad, fecha, asignado.

import { getAll, put, del, newId } from '../core/db.js';
import { fmtDate } from '../core/format.js';
import { openModal, confirmModal } from '../components/modal.js';
import { toast } from '../core/notifications.js';
import * as Audit from '../core/audit.js';
import { emptyState } from '../components/empty-state.js';

const COLUMNS = [
  { id: 'todo', label: 'Pendiente', color: '#fff1e6' },
  { id: 'doing', label: 'En curso', color: '#fef3c7' },
  { id: 'done', label: 'Hecho', color: '#dcfce7' },
];

export async function mount(el) { await render(el); }

async function render(el) {
  const [tasks, employees] = await Promise.all([getAll('tasks'), getAll('employees')]);
  const empMap = Object.fromEntries(employees.map(e => [e.id, `${e.name} ${e.lastname || ''}`]));

  el.innerHTML = `
    <div class="mb-6 flex justify-between items-center">
      <div>
        <h1 class="text-3xl font-black text-[#241a0d]">Tareas</h1>
        <p class="text-sm text-[#7d6c5c] mt-1">Tablero Kanban · arrastrá las tarjetas entre columnas</p>
      </div>
      <button id="t-new" class="ing-btn-primary flex items-center gap-2"><span class="material-symbols-outlined text-base">add</span> Nueva tarea</button>
    </div>

    <div class="grid grid-cols-3 gap-4">
      ${COLUMNS.map(col => {
        const colTasks = tasks.filter(t => (t.column || 'todo') === col.id).sort((a, b) => (a.order || 0) - (b.order || 0));
        return `
          <div class="rounded-2xl p-3 min-h-[500px]" style="background:${col.color}" data-col="${col.id}">
            <div class="flex items-center justify-between mb-3 px-2">
              <div class="flex items-center gap-2"><span class="font-black text-[#241a0d]">${col.label}</span><span class="bg-white/60 text-[#7d6c5c] text-xs font-bold px-2 py-0.5 rounded-full">${colTasks.length}</span></div>
              <button data-add-col="${col.id}" class="w-6 h-6 rounded-full bg-white/60 hover:bg-white text-[#7d6c5c] flex items-center justify-center"><span class="material-symbols-outlined text-sm">add</span></button>
            </div>
            <div class="space-y-2 min-h-[400px]" data-dropzone="${col.id}">
              ${colTasks.length ? colTasks.map(t => card(t, empMap)).join('') : `<div class="pt-6">${emptyState({ icon: 'checklist', title: 'Vacío', hint: 'Arrastrá o creá una tarea.', ctaLabel: 'Nueva', ctaAttr: `data-add-col="${col.id}"`, compact: true })}</div>`}
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;

  // Drag & drop
  el.querySelectorAll('[data-task-card]').forEach(c => {
    c.addEventListener('dragstart', (ev) => { ev.dataTransfer.setData('text/plain', c.dataset.taskCard); c.classList.add('opacity-50'); });
    c.addEventListener('dragend', () => c.classList.remove('opacity-50'));
    c.addEventListener('click', async (ev) => { if (ev.target.closest('button')) return; const t = tasks.find(x => x.id === c.dataset.taskCard); if (t) editTask(el, t, employees); });
  });
  el.querySelectorAll('[data-dropzone]').forEach(zone => {
    zone.addEventListener('dragover', (ev) => { ev.preventDefault(); zone.classList.add('ring-2', 'ring-[#d82f1e]'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('ring-2', 'ring-[#d82f1e]'));
    zone.addEventListener('drop', async (ev) => {
      ev.preventDefault();
      zone.classList.remove('ring-2', 'ring-[#d82f1e]');
      const id = ev.dataTransfer.getData('text/plain');
      const col = zone.dataset.dropzone;
      const dragged = tasks.find(x => x.id === id);
      if (!dragged) return;
      // G-7: calcular nuevo orden dentro de la columna según posición Y del drop.
      const cards = Array.from(zone.querySelectorAll('[data-task-card]')).filter(c => c.dataset.taskCard !== id);
      const y = ev.clientY;
      let insertIdx = cards.length;
      for (let i = 0; i < cards.length; i++) {
        const r = cards[i].getBoundingClientRect();
        if (y < r.top + r.height / 2) { insertIdx = i; break; }
      }
      const colTasks = tasks
        .filter(x => (x.column || 'todo') === col && x.id !== id)
        .sort((a, b) => (a.order || 0) - (b.order || 0));
      colTasks.splice(insertIdx, 0, dragged);
      const oldCol = dragged.column;
      dragged.column = col;
      // Re-numerar orden 1..N (espaciado 10 para permitir inserts futuros sin chocar).
      for (let i = 0; i < colTasks.length; i++) {
        const t = colTasks[i];
        const newOrder = (i + 1) * 10;
        if (t.order !== newOrder || (t === dragged && oldCol !== col)) {
          t.order = newOrder;
          await put('tasks', t);
        }
      }
      await Audit.log({
        action: oldCol !== col ? 'move' : 'reorder',
        entity: 'tarea', entity_id: id, after: dragged,
        description: oldCol !== col ? `${oldCol} → ${col} (pos ${insertIdx + 1})` : `reorder en ${col} → pos ${insertIdx + 1}`,
      });
      render(el);
    });
  });

  el.querySelectorAll('[data-del-task]').forEach(b => b.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    const ok = await confirmModal({ title: 'Borrar tarea', message: '¿Eliminar esta tarea?', danger: true, confirmLabel: 'Borrar' });
    if (!ok) return;
    await del('tasks', b.dataset.delTask);
    await Audit.log({ action: 'delete', entity: 'tarea', entity_id: b.dataset.delTask, description: 'Tarea eliminada' });
    render(el);
  }));

  el.querySelector('#t-new').addEventListener('click', () => editTask(el, null, employees));
  el.querySelectorAll('[data-add-col]').forEach(b => b.addEventListener('click', () => editTask(el, null, employees, b.dataset.addCol)));
}

function card(t, empMap) {
  const prioColor = { high: 'bg-red-100 text-red-700', med: 'bg-orange-100 text-orange-700', low: 'bg-blue-100 text-blue-700' };
  const prio = t.priority || 'med';
  const overdue = t.due_date && t.due_date < new Date().toISOString().slice(0, 10) && t.column !== 'done';
  return `
    <div draggable="true" data-task-card="${t.id}" class="bg-white rounded-xl p-3 shadow-sm hover:shadow-md transition-all cursor-grab active:cursor-grabbing ${overdue ? 'ring-2 ring-red-400' : ''}">
      <div class="flex items-start justify-between gap-2 mb-2">
        <div class="font-bold text-sm text-[#241a0d]">${t.title}</div>
        <button data-del-task="${t.id}" class="text-[#7d6c5c] hover:text-red-600 shrink-0"><span class="material-symbols-outlined text-sm">close</span></button>
      </div>
      ${t.description ? `<div class="text-xs text-[#7d6c5c] mb-2 line-clamp-2">${t.description}</div>` : ''}
      <div class="flex flex-wrap items-center gap-1">
        <span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${prioColor[prio]}">${prio === 'high' ? 'Alta' : prio === 'low' ? 'Baja' : 'Media'}</span>
        ${t.due_date ? `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${overdue?'bg-red-600 text-white':'bg-[#fff1e6] text-[#7d6c5c]'}">${fmtDate(t.due_date)}</span>` : ''}
        ${t.assignee_id ? `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-[#fff1e6] text-[#7d6c5c]">${empMap[t.assignee_id] || ''}</span>` : ''}
      </div>
    </div>
  `;
}

async function editTask(root, existing, employees, defaultCol = 'todo') {
  const isNew = !existing;
  const t = existing || {
    id: newId('tsk'), title: '', description: '', column: defaultCol,
    priority: 'med', due_date: '', assignee_id: '', order: Date.now(),
    created_at: new Date().toISOString(),
  };
  await openModal({
    title: isNew ? 'Nueva tarea' : 'Editar tarea',
    size: 'md',
    bodyHTML: `
      <div class="space-y-3">
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Título *</label><input id="t-title" value="${t.title||''}" class="ing-input w-full mt-1" autofocus /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Descripción</label><textarea id="t-desc" rows="3" class="ing-input w-full mt-1">${t.description||''}</textarea></div>
        <div class="grid grid-cols-3 gap-3">
          <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Columna</label>
            <select id="t-col" class="ing-input w-full mt-1">${COLUMNS.map(c => `<option value="${c.id}" ${t.column===c.id?'selected':''}>${c.label}</option>`).join('')}</select>
          </div>
          <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Prioridad</label>
            <select id="t-prio" class="ing-input w-full mt-1">
              <option value="low" ${t.priority==='low'?'selected':''}>Baja</option>
              <option value="med" ${t.priority==='med'?'selected':''}>Media</option>
              <option value="high" ${t.priority==='high'?'selected':''}>Alta</option>
            </select>
          </div>
          <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Vence</label><input id="t-due" type="date" value="${t.due_date||''}" class="ing-input w-full mt-1" /></div>
        </div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Asignado</label>
          <select id="t-ass" class="ing-input w-full mt-1"><option value="">— Sin asignar —</option>${employees.map(e => `<option value="${e.id}" ${t.assignee_id===e.id?'selected':''}>${e.name} ${e.lastname||''}</option>`).join('')}</select>
        </div>
      </div>
    `,
    footerHTML: `<button class="ing-btn-secondary" data-act="cancel">Cancelar</button><button class="ing-btn-primary" data-act="ok">${isNew?'Crear':'Guardar'}</button>`,
    onOpen: (m, close) => {
      m.querySelector('[data-act="cancel"]').addEventListener('click', () => close(false));
      m.querySelector('[data-act="ok"]').addEventListener('click', async () => {
        t.title = m.querySelector('#t-title').value.trim();
        if (!t.title) { toast('Título requerido', 'warn'); return; }
        t.description = m.querySelector('#t-desc').value;
        t.column = m.querySelector('#t-col').value;
        t.priority = m.querySelector('#t-prio').value;
        t.due_date = m.querySelector('#t-due').value;
        t.assignee_id = m.querySelector('#t-ass').value || null;
        t.updated_at = new Date().toISOString();
        await put('tasks', t);
        await Audit.log({ action: isNew?'create':'update', entity: 'tarea', entity_id: t.id, after: t, description: t.title });
        toast(isNew?'Tarea creada':'Tarea actualizada', 'success');
        close(true);
      });
    },
  });
  render(root);
}
