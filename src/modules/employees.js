// Empleados — CRUD + tabla mensual de horas por empleado editable.
// MIGRADO A "TODO ONLINE": empleados y turnos viven en el backend (compartidos
// entre las dos sucursales). Antes vivían en IndexedDB local de cada PC.
// Tabs: Lista | Horas del mes.

import { getAll, del } from '../core/db.js';
import * as Employees from '../repos/employees.js';
import { money, fmtDate, monthKey, hoursBetween, hoursDecimal } from '../core/format.js';
import { openModal, confirmModal } from '../components/modal.js';
import { toast } from '../core/notifications.js';
import { exportToXLSX } from '../core/xlsx.js';
import { emptyRow } from '../components/empty-state.js';

const state = {
  tab: 'list',
  month: monthKey(),
  selectedEmployee: null,
};

function esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

export async function mount(el) { await render(el); }

async function render(el) {
  const [employees, branches, localEmps] = await Promise.all([
    Employees.list().catch(() => []),
    getAll('branches').catch(() => []),
    getAll('employees').catch(() => []),
  ]);
  const brMap = Object.fromEntries((branches || []).map(b => [b.id, b.name]));

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
    ${localEmps.length ? `
    <div class="ing-card p-3 mb-4 border-l-4 border-amber-500 bg-amber-50 flex items-center justify-between gap-3 flex-wrap">
      <div class="text-sm text-[#241a0d]"><b>${localEmps.length} empleado(s)</b> quedaron guardados solo en esta PC. Importalos al servidor para verlos en todas las sucursales.</div>
      <button id="em-migrate" class="ing-btn-primary !py-1.5 !px-3 text-sm shrink-0">Importar ${localEmps.length} al servidor</button>
    </div>` : ''}
    <div class="flex gap-2 mb-4 border-b border-[#fff1e6]">
      ${tabBtn('list','Lista','people')}
      ${tabBtn('hours','Horas del mes','schedule')}
    </div>
    <div id="em-content"></div>
  `;
  el.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => { state.tab = b.dataset.tab; render(el); }));
  el.querySelector('#em-new').addEventListener('click', () => editEmp(el, null, branches));
  el.querySelector('#em-migrate')?.addEventListener('click', (ev) => migrateLocalEmployees(el, localEmps, ev.currentTarget));
  const content = el.querySelector('#em-content');
  if (state.tab === 'list') renderList(el, content, employees, brMap, branches);
  if (state.tab === 'hours') renderHours(el, content, employees, branches);
}

function tabBtn(id, label, icon) {
  const active = state.tab === id;
  return `<button data-tab="${id}" class="flex items-center gap-2 px-4 py-3 font-bold text-sm border-b-2 transition-all ${active ? 'border-[#d82f1e] text-[#d82f1e]' : 'border-transparent text-[#7d6c5c] hover:text-[#d82f1e]'}">
    <span class="material-symbols-outlined text-base">${icon}</span>${label}
  </button>`;
}

async function migrateLocalEmployees(root, localEmps, btn) {
  if (btn) { if (btn.disabled) return; btn.disabled = true; btn.textContent = 'Importando…'; }
  let imported = 0, failed = 0;
  for (const e of localEmps) {
    if (!e.name) { try { await del('employees', e.id); } catch { /* noop */ } continue; }
    try {
      await Employees.create({
        name: e.name,
        lastname: e.lastname || null,
        email: e.email || null,
        phone: e.phone || null,
        branchId: e.branch_id || null,
        role: e.role || null,
        hourlyRate: Number(e.hourly_rate) || 0,
        hireDate: e.hire_date || null,
        active: e.active !== false,
      });
      imported++;
      try { await del('employees', e.id); } catch { /* noop */ }
    } catch { failed++; }
  }
  toast(`Importados: ${imported}${failed ? ` · con error: ${failed}` : ''}`, failed ? 'warn' : 'success');
  render(root);
}

function renderList(root, container, employees, brMap, branches) {
  container.innerHTML = `
    <div class="ing-card overflow-hidden">
      <table class="ing-table w-full">
        <thead><tr><th>Nombre</th><th>Sucursal</th><th>Rol</th><th>Email / Tel</th><th class="text-right">$/hora</th><th>Ingreso</th><th>Estado</th><th></th></tr></thead>
        <tbody>
          ${employees.length ? employees.map(e => `
            <tr>
              <td class="font-bold">${esc(e.name)} ${esc(e.lastname || '')}</td>
              <td>${esc(brMap[e.branchId] || '-')}</td>
              <td class="text-xs">${esc(e.role || '-')}</td>
              <td class="text-xs">${esc(e.email || '')}${e.phone?'<br>'+esc(e.phone):''}</td>
              <td class="text-right font-bold">${money(e.hourlyRate || 0)}</td>
              <td class="text-xs">${e.hireDate ? fmtDate(e.hireDate) : '-'}</td>
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
  container.querySelector('[data-empty-new="emp"]')?.addEventListener('click', () => editEmp(root, null, branches));
  container.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => {
    const emp = employees.find(x => x.id === b.dataset.edit);
    editEmp(root, emp, branches);
  }));
  container.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    const ok = await confirmModal({ title: 'Borrar', message: '¿Eliminar empleado?', danger: true, confirmLabel: 'Borrar' });
    if (!ok) return;
    try { await Employees.remove(b.dataset.del); toast('Eliminado', 'success'); render(root); }
    catch (e) { toast(e?.message || 'No se pudo eliminar', 'error'); }
  }));
}

async function editEmp(root, existing, branches) {
  const isNew = !existing;
  const e = existing || {
    name: '', lastname: '', email: '', phone: '',
    branchId: branches[0]?.id || '', role: '', hourlyRate: 0,
    hireDate: new Date().toISOString().slice(0, 10), active: true,
  };
  await openModal({
    title: isNew ? 'Nuevo empleado' : `Editar empleado`,
    size: 'md',
    bodyHTML: `
      <div class="grid grid-cols-2 gap-3">
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Nombre *</label><input id="e-name" value="${esc(e.name)}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Apellido</label><input id="e-last" value="${esc(e.lastname)}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Email</label><input id="e-email" type="email" value="${esc(e.email)}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Teléfono</label><input id="e-phone" value="${esc(e.phone)}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Sucursal</label>
          <select id="e-branch" class="ing-input w-full mt-1">${branches.map(b => `<option value="${b.id}" ${e.branchId===b.id?'selected':''}>${esc(b.name)}</option>`).join('')}</select>
        </div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Rol</label><input id="e-role" value="${esc(e.role)}" class="ing-input w-full mt-1" placeholder="Vendedor, Cajero…" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">$ por hora</label><input id="e-rate" type="number" step="0.01" value="${e.hourlyRate||0}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Ingreso</label><input id="e-hire" type="date" value="${e.hireDate ? String(e.hireDate).slice(0,10) : ''}" class="ing-input w-full mt-1" /></div>
        <div class="col-span-2"><label class="flex items-center gap-2"><input id="e-act" type="checkbox" ${e.active?'checked':''} /> <span class="text-sm">Activo</span></label></div>
      </div>
    `,
    footerHTML: `<button class="ing-btn-secondary" data-act="cancel">Cancelar</button><button class="ing-btn-primary" data-act="ok">${isNew?'Crear':'Guardar'}</button>`,
    onOpen: (m, close) => {
      m.querySelector('[data-act="cancel"]').addEventListener('click', () => close(false));
      const okBtn = m.querySelector('[data-act="ok"]');
      okBtn.addEventListener('click', async () => {
        const name = m.querySelector('#e-name').value.trim();
        if (!name) { toast('Nombre requerido', 'warn'); return; }
        const body = {
          name,
          lastname: m.querySelector('#e-last').value.trim() || null,
          email: m.querySelector('#e-email').value.trim() || null,
          phone: m.querySelector('#e-phone').value.trim() || null,
          branchId: m.querySelector('#e-branch').value || null,
          role: m.querySelector('#e-role').value.trim() || null,
          hourlyRate: Number(m.querySelector('#e-rate').value) || 0,
          hireDate: m.querySelector('#e-hire').value || null,
          active: m.querySelector('#e-act').checked,
        };
        if (okBtn.disabled) return;
        okBtn.disabled = true;
        try {
          if (isNew) await Employees.create(body);
          else await Employees.update(existing.id, body);
          toast(isNew ? 'Creado' : 'Guardado', 'success');
          close(true);
          render(root);
        } catch (err) {
          toast(err?.message || 'No se pudo guardar', 'error');
          okBtn.disabled = false;
        }
      });
    },
  });
}

// ===== HORAS =====
async function renderHours(root, container, employees, branches) {
  const month = state.month;
  if (!state.selectedEmployee && employees.length) state.selectedEmployee = employees[0].id;
  const emp = employees.find(x => x.id === state.selectedEmployee);
  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const days = Array.from({length: daysInMonth}, (_, i) => `${month}-${String(i+1).padStart(2, '0')}`);

  const shifts = state.selectedEmployee ? await Employees.listShifts(state.selectedEmployee, month).catch(() => []) : [];
  const shiftByDay = Object.fromEntries(shifts.map(s => [s.date, s]));

  let totalHours = 0;
  for (const s of shifts) totalHours += hoursDecimal(s.checkIn, s.checkOut);
  const totalPay = totalHours * (emp?.hourlyRate || 0);

  container.innerHTML = `
    <div class="flex items-center gap-3 mb-4">
      <select id="hr-emp" class="ing-input">${employees.map(e => `<option value="${e.id}" ${state.selectedEmployee===e.id?'selected':''}>${esc(e.name)} ${esc(e.lastname||'')}</option>`).join('')}</select>
      <input type="month" id="hr-month" value="${month}" class="ing-input" />
      <div class="flex-1"></div>
      <button id="hr-export" class="ing-btn-secondary flex items-center gap-2"><span class="material-symbols-outlined text-base">download</span> Exportar mes</button>
    </div>
    <div class="grid grid-cols-3 gap-3 mb-4">
      <div class="ing-card p-4"><div class="text-[10px] font-black uppercase text-[#7d6c5c]">Horas del mes</div><div class="text-2xl font-black text-[#d82f1e]">${totalHours.toFixed(1)} h</div></div>
      <div class="ing-card p-4"><div class="text-[10px] font-black uppercase text-[#7d6c5c]">$ por hora</div><div class="text-2xl font-black">${money(emp?.hourlyRate || 0)}</div></div>
      <div class="ing-card p-4"><div class="text-[10px] font-black uppercase text-[#7d6c5c]">Pago del mes</div><div class="text-2xl font-black text-green-700">${money(totalPay)}</div></div>
    </div>
    <div class="ing-card overflow-hidden">
      <table class="ing-table w-full">
        <thead><tr><th>Día</th><th>Entrada</th><th>Salida</th><th class="text-right">Horas</th><th class="text-right">$</th><th>Nota</th></tr></thead>
        <tbody>
          ${days.map(d => {
            const s = shiftByDay[d];
            const hs = s && s.checkIn && s.checkOut ? hoursBetween(s.checkIn, s.checkOut) : '—';
            const pay = s && s.checkIn && s.checkOut ? hoursDecimal(s.checkIn, s.checkOut) * (emp?.hourlyRate || 0) : 0;
            const weekday = new Date(d + 'T12:00').toLocaleDateString('es-AR', { weekday: 'short' });
            return `
              <tr class="${s ? '' : 'opacity-60'}">
                <td class="font-mono text-xs">${d.slice(-2)} <span class="text-[#7d6c5c]">${weekday}</span></td>
                <td><input data-d="${d}" data-f="checkIn" type="time" value="${s?.checkIn || ''}" class="ing-input w-24 text-sm" /></td>
                <td><input data-d="${d}" data-f="checkOut" type="time" value="${s?.checkOut || ''}" class="ing-input w-24 text-sm" /></td>
                <td class="text-right font-bold">${hs}</td>
                <td class="text-right">${pay ? money(pay) : '—'}</td>
                <td><input data-d="${d}" data-f="note" value="${esc(s?.notes || '')}" placeholder="—" class="ing-input w-full text-sm" /></td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;

  container.querySelector('#hr-emp').addEventListener('change', (ev) => { state.selectedEmployee = ev.target.value; render(root); });
  container.querySelector('#hr-month').addEventListener('change', (ev) => { state.month = ev.target.value; render(root); });
  container.querySelectorAll('input[data-d]').forEach(inp => inp.addEventListener('change', async () => {
    const date = inp.dataset.d, field = inp.dataset.f;
    const cur = shiftByDay[date] || {};
    const body = {
      employeeId: state.selectedEmployee,
      date,
      checkIn: field === 'checkIn' ? inp.value : (cur.checkIn ?? null),
      checkOut: field === 'checkOut' ? inp.value : (cur.checkOut ?? null),
      note: field === 'note' ? inp.value : (cur.notes ?? null),
    };
    try { await Employees.saveShift(body); render(root); }
    catch (e) { toast(e?.message || 'No se pudo guardar el turno', 'error'); }
  }));
  container.querySelector('#hr-export').addEventListener('click', () => {
    const rows = days.map(d => {
      const s = shiftByDay[d];
      return {
        Fecha: d, Dia: new Date(d + 'T12:00').toLocaleDateString('es-AR', { weekday: 'short' }),
        Entrada: s?.checkIn || '', Salida: s?.checkOut || '',
        Horas: s?.checkIn && s?.checkOut ? hoursBetween(s.checkIn, s.checkOut) : '',
        Pago: s?.checkIn && s?.checkOut ? (hoursDecimal(s.checkIn, s.checkOut) * (emp?.hourlyRate || 0)) : 0,
        Nota: s?.notes || '',
      };
    });
    const totalRow = { Fecha: 'TOTAL', Dia: '', Entrada: '', Salida: '', Horas: totalHours.toFixed(2), Pago: totalPay, Nota: '' };
    exportToXLSX({
      filename: `horas_${(emp?.name||'empleado').replace(/\s+/g, '_')}_${month}.xlsx`,
      sheets: [{ name: month, rows: [...rows, totalRow] }],
    });
    toast('Exportado', 'success');
  });
}
