// Empleados — CRUD + tabla mensual de horas por empleado editable.
// Tabs: Lista | Horas del mes.

import { getAll, put, del, newId } from '../core/db.js';
import { money, fmtDate, monthKey, hoursBetween, hoursDecimal } from '../core/format.js';
import { openModal, confirmModal } from '../components/modal.js';
import { toast } from '../core/notifications.js';
import * as Audit from '../core/audit.js';
import { exportToXLSX } from '../core/xlsx.js';
import { emptyRow } from '../components/empty-state.js';

const state = {
  tab: 'list',
  month: monthKey(),
  selectedEmployee: null,
};

export async function mount(el) { await render(el); }

async function render(el) {
  const [employees, branches] = await Promise.all([getAll('employees'), getAll('branches')]);
  const brMap = Object.fromEntries(branches.map(b => [b.id, b.name]));

  el.innerHTML = `
    <div class="mb-6 flex justify-between items-center">
      <div>
        <h1 class="text-3xl font-black text-[#241a0d]">Empleados</h1>
        <p class="text-sm text-[#7d6c5c] mt-1">${employees.filter(e => e.active).length} activos · ${employees.length} total</p>
      </div>
      <div class="flex gap-2">
        <button id="em-new" class="ing-btn-primary flex items-center gap-2"><span class="material-symbols-outlined text-base">add</span> Nuevo empleado</button>
      </div>
    </div>
    <div class="flex gap-2 mb-4 border-b border-[#fff1e6]">
      ${tabBtn('list','Lista','people')}
      ${tabBtn('hours','Horas del mes','schedule')}
    </div>
    <div id="em-content"></div>
  `;
  el.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => { state.tab = b.dataset.tab; render(el); }));
  el.querySelector('#em-new').addEventListener('click', () => editEmp(el, null, branches));
  const content = el.querySelector('#em-content');
  if (state.tab === 'list') renderList(content, employees, brMap);
  if (state.tab === 'hours') renderHours(content, employees, branches);
}

function tabBtn(id, label, icon) {
  const active = state.tab === id;
  return `<button data-tab="${id}" class="flex items-center gap-2 px-4 py-3 font-bold text-sm border-b-2 transition-all ${active ? 'border-[#d82f1e] text-[#d82f1e]' : 'border-transparent text-[#7d6c5c] hover:text-[#d82f1e]'}">
    <span class="material-symbols-outlined text-base">${icon}</span>${label}
  </button>`;
}

function renderList(container, employees, brMap) {
  container.innerHTML = `
    <div class="ing-card overflow-hidden">
      <table class="ing-table w-full">
        <thead><tr><th>Nombre</th><th>Sucursal</th><th>Rol</th><th>Email / Tel</th><th class="text-right">$/hora</th><th>Ingreso</th><th>Estado</th><th></th></tr></thead>
        <tbody>
          ${employees.length ? employees.map(e => `
            <tr>
              <td class="font-bold">${e.name} ${e.lastname || ''}</td>
              <td>${brMap[e.branch_id] || '-'}</td>
              <td class="text-xs">${e.role || '-'}</td>
              <td class="text-xs">${e.email || ''}${e.phone?'<br>'+e.phone:''}</td>
              <td class="text-right font-bold">${money(e.hourly_rate)}</td>
              <td class="text-xs">${e.hire_date ? fmtDate(e.hire_date) : '-'}</td>
              <td>${e.active ? '<span class="text-green-600 font-bold text-xs">ACTIVO</span>' : '<span class="text-[#7d6c5c] text-xs">INACTIVO</span>'}</td>
              <td class="text-right">
                <button data-edit="${e.id}" class="text-xs text-[#d82f1e] hover:underline">Editar</button>
                <button data-del="${e.id}" class="text-xs text-[#7d6c5c] hover:text-red-600 ml-1">Borrar</button>
              </td>
            </tr>
          `).join('') : emptyRow(8, { icon: 'badge', title: 'Sin empleados', hint: 'Registrá al primer empleado para asignarle sucursal, turnos y tarifa horaria.', ctaLabel: 'Nuevo empleado', ctaAttr: 'data-empty-new="emp"' })}
        </tbody>
      </table>
    </div>
  `;
  container.querySelector('[data-empty-new="emp"]')?.addEventListener('click', async () => {
    const branches = await getAll('branches');
    editEmp(container.closest('#main-content') || container.parentElement, null, branches);
  });
  container.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', async () => {
    const emp = employees.find(x => x.id === b.dataset.edit);
    const branches = await getAll('branches');
    editEmp(container.closest('#main-content') || container.parentElement, emp, branches);
  }));
  container.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    const ok = await confirmModal({ title: 'Borrar', message: '¿Eliminar empleado?', danger: true, confirmLabel: 'Borrar' });
    if (!ok) return;
    await del('employees', b.dataset.del);
    await Audit.log({ action: 'delete', entity: 'empleado', entity_id: b.dataset.del, description: 'Empleado eliminado' });
    toast('Eliminado', 'success');
    render(container.closest('#main-content') || container.parentElement);
  }));
}

async function editEmp(root, existing, branches) {
  const isNew = !existing;
  const e = existing || {
    id: newId('emp'), name: '', lastname: '', email: '', phone: '',
    branch_id: branches[0]?.id || '', role: '', hourly_rate: 0,
    hire_date: new Date().toISOString().slice(0, 10), active: true,
  };
  await openModal({
    title: isNew ? 'Nuevo empleado' : `Editar empleado`,
    size: 'md',
    bodyHTML: `
      <div class="grid grid-cols-2 gap-3">
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Nombre *</label><input id="e-name" value="${e.name||''}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Apellido</label><input id="e-last" value="${e.lastname||''}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Email</label><input id="e-email" type="email" value="${e.email||''}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Teléfono</label><input id="e-phone" value="${e.phone||''}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Sucursal</label>
          <select id="e-branch" class="ing-input w-full mt-1">${branches.map(b => `<option value="${b.id}" ${e.branch_id===b.id?'selected':''}>${b.name}</option>`).join('')}</select>
        </div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Rol</label><input id="e-role" value="${e.role||''}" class="ing-input w-full mt-1" placeholder="Vendedor, Cajero…" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">$ por hora</label><input id="e-rate" type="number" step="0.01" value="${e.hourly_rate||0}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Ingreso</label><input id="e-hire" type="date" value="${e.hire_date||''}" class="ing-input w-full mt-1" /></div>
        <div class="col-span-2"><label class="flex items-center gap-2"><input id="e-act" type="checkbox" ${e.active?'checked':''} /> <span class="text-sm">Activo</span></label></div>
      </div>
    `,
    footerHTML: `<button class="ing-btn-secondary" data-act="cancel">Cancelar</button><button class="ing-btn-primary" data-act="ok">${isNew?'Crear':'Guardar'}</button>`,
    onOpen: (m, close) => {
      m.querySelector('[data-act="cancel"]').addEventListener('click', () => close(false));
      m.querySelector('[data-act="ok"]').addEventListener('click', async () => {
        e.name = m.querySelector('#e-name').value.trim();
        if (!e.name) { toast('Nombre requerido', 'warn'); return; }
        e.lastname = m.querySelector('#e-last').value.trim();
        e.email = m.querySelector('#e-email').value.trim();
        e.phone = m.querySelector('#e-phone').value.trim();
        e.branch_id = m.querySelector('#e-branch').value;
        e.role = m.querySelector('#e-role').value.trim();
        e.hourly_rate = Number(m.querySelector('#e-rate').value) || 0;
        e.hire_date = m.querySelector('#e-hire').value;
        e.active = m.querySelector('#e-act').checked;
        await put('employees', e);
        await Audit.log({ action: isNew?'create':'update', entity: 'empleado', entity_id: e.id, after: e, description: e.name });
        toast(isNew?'Creado':'Guardado', 'success');
        close(true);
      });
    },
  });
  render(root);
}

// ===== HORAS =====
async function renderHours(container, employees, branches) {
  const shifts = await getAll('shifts');
  const month = state.month;
  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const days = Array.from({length: daysInMonth}, (_, i) => `${month}-${String(i+1).padStart(2, '0')}`);
  if (!state.selectedEmployee && employees.length) state.selectedEmployee = employees[0].id;
  const emp = employees.find(x => x.id === state.selectedEmployee);

  const empShifts = shifts.filter(s => s.employee_id === state.selectedEmployee && s.date.startsWith(month));
  const shiftByDay = Object.fromEntries(empShifts.map(s => [s.date, s]));

  let totalHours = 0;
  for (const s of empShifts) totalHours += hoursDecimal(s.check_in, s.check_out);
  const totalPay = totalHours * (emp?.hourly_rate || 0);

  container.innerHTML = `
    <div class="flex items-center gap-3 mb-4">
      <select id="hr-emp" class="ing-input">${employees.map(e => `<option value="${e.id}" ${state.selectedEmployee===e.id?'selected':''}>${e.name} ${e.lastname||''}</option>`).join('')}</select>
      <input type="month" id="hr-month" value="${month}" class="ing-input" />
      <div class="flex-1"></div>
      <button id="hr-export" class="ing-btn-secondary flex items-center gap-2"><span class="material-symbols-outlined text-base">download</span> Exportar mes</button>
    </div>
    <div class="grid grid-cols-3 gap-3 mb-4">
      <div class="ing-card p-4"><div class="text-[10px] font-black uppercase text-[#7d6c5c]">Horas del mes</div><div class="text-2xl font-black text-[#d82f1e]">${totalHours.toFixed(1)} h</div></div>
      <div class="ing-card p-4"><div class="text-[10px] font-black uppercase text-[#7d6c5c]">$ por hora</div><div class="text-2xl font-black">${money(emp?.hourly_rate || 0)}</div></div>
      <div class="ing-card p-4"><div class="text-[10px] font-black uppercase text-[#7d6c5c]">Pago del mes</div><div class="text-2xl font-black text-green-700">${money(totalPay)}</div></div>
    </div>
    <div class="ing-card overflow-hidden">
      <table class="ing-table w-full">
        <thead><tr><th>Día</th><th>Entrada</th><th>Salida</th><th class="text-right">Horas</th><th class="text-right">$</th><th>Nota</th></tr></thead>
        <tbody>
          ${days.map(d => {
            const s = shiftByDay[d];
            const hs = s && s.check_in && s.check_out ? hoursBetween(s.check_in, s.check_out) : '—';
            const pay = s && s.check_in && s.check_out ? hoursDecimal(s.check_in, s.check_out) * (emp?.hourly_rate || 0) : 0;
            const weekday = new Date(d + 'T12:00').toLocaleDateString('es-AR', { weekday: 'short' });
            return `
              <tr class="${s ? '' : 'opacity-60'}">
                <td class="font-mono text-xs">${d.slice(-2)} <span class="text-[#7d6c5c]">${weekday}</span></td>
                <td><input data-d="${d}" data-f="check_in" type="time" value="${s?.check_in || ''}" class="ing-input w-24 text-sm" /></td>
                <td><input data-d="${d}" data-f="check_out" type="time" value="${s?.check_out || ''}" class="ing-input w-24 text-sm" /></td>
                <td class="text-right font-bold">${hs}</td>
                <td class="text-right">${pay ? money(pay) : '—'}</td>
                <td><input data-d="${d}" data-f="note" value="${s?.note || ''}" placeholder="—" class="ing-input w-full text-sm" /></td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;

  container.querySelector('#hr-emp').addEventListener('change', (ev) => { state.selectedEmployee = ev.target.value; render(container.closest('#main-content') || container.parentElement); });
  container.querySelector('#hr-month').addEventListener('change', (ev) => { state.month = ev.target.value; render(container.closest('#main-content') || container.parentElement); });
  container.querySelectorAll('input[data-d]').forEach(inp => inp.addEventListener('change', async (ev) => {
    const date = inp.dataset.d; const field = inp.dataset.f;
    const id = `shift_${state.selectedEmployee}_${date}`;
    const cur = shiftByDay[date] || { id, employee_id: state.selectedEmployee, date, check_in: '', check_out: '', note: '' };
    cur[field] = inp.value;
    await put('shifts', cur);
    render(container.closest('#main-content') || container.parentElement);
  }));
  container.querySelector('#hr-export').addEventListener('click', () => {
    const rows = days.map(d => {
      const s = shiftByDay[d];
      return {
        Fecha: d, Dia: new Date(d + 'T12:00').toLocaleDateString('es-AR', { weekday: 'short' }),
        Entrada: s?.check_in || '', Salida: s?.check_out || '',
        Horas: s?.check_in && s?.check_out ? hoursBetween(s.check_in, s.check_out) : '',
        Pago: s?.check_in && s?.check_out ? (hoursDecimal(s.check_in, s.check_out) * (emp?.hourly_rate || 0)) : 0,
        Nota: s?.note || '',
      };
    });
    const totalRow = { Fecha: 'TOTAL', Dia: '', Entrada: '', Salida: '', Horas: totalHours.toFixed(2), Pago: totalPay, Nota: '' };
    exportToXLSX({
      filename: `horas_${emp.name.replace(/\s+/g, '_')}_${month}.xlsx`,
      sheets: [{ name: month, rows: [...rows, totalRow] }],
    });
    toast('Exportado', 'success');
  });
}
