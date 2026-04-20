// Configuración — empresa, sucursales, usuarios, métodos de pago, reinicio de sistema.

import { get, getAll, put, del, newId } from '../core/db.js';
import { resetAllData, runSeed } from '../core/seed.js';
import { openModal, confirmModal } from '../components/modal.js';
import { toast } from '../core/notifications.js';
import { logout } from '../core/auth.js';
import * as Audit from '../core/audit.js';
import { derivePin } from '../core/crypto.js';
import { exportBackup, importBackup, markBackupNow, checkBackupReminder } from '../core/backup.js';
import { verifyChain } from '../core/audit.js';

const state = { tab: 'company' };

export async function mount(el) { await render(el); }

async function render(el) {
  el.innerHTML = `
    <div class="mb-6">
      <h1 class="text-3xl font-black text-[#241a0d]">Configuración</h1>
      <p class="text-sm text-[#7d6c5c] mt-1">Ajustes del sistema</p>
    </div>

    <div class="flex gap-2 mb-5 border-b border-[#fff1e6] overflow-x-auto">
      ${tabBtn('company', 'Empresa', 'domain')}
      ${tabBtn('branches', 'Sucursales', 'store')}
      ${tabBtn('users', 'Usuarios', 'group')}
      ${tabBtn('payments', 'Métodos de pago', 'credit_card')}
      ${tabBtn('system', 'Sistema', 'settings')}
      ${tabBtn('danger', 'Zona peligrosa', 'warning')}
    </div>

    <div id="st-content"></div>
  `;
  el.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => { state.tab = b.dataset.tab; render(el); }));
  const c = el.querySelector('#st-content');
  if (state.tab === 'company') await renderCompany(c);
  if (state.tab === 'branches') await renderBranches(c);
  if (state.tab === 'users') await renderUsers(c);
  if (state.tab === 'payments') await renderPayments(c);
  if (state.tab === 'system') await renderSystem(c);
  if (state.tab === 'danger') await renderDanger(c);
}

function tabBtn(id, label, icon) {
  const active = state.tab === id;
  return `<button data-tab="${id}" class="flex items-center gap-2 px-4 py-3 font-bold text-sm border-b-2 whitespace-nowrap transition-all ${active ? 'border-[#d82f1e] text-[#d82f1e]' : 'border-transparent text-[#7d6c5c] hover:text-[#d82f1e]'}">
    <span class="material-symbols-outlined text-base">${icon}</span>${label}
  </button>`;
}

// ===== EMPRESA =====
async function renderCompany(container) {
  const cfg = (await get('config', 'company'))?.value || { name: '', cuit: '', address: '', phone: '', email: '' };
  container.innerHTML = `
    <div class="ing-card p-5 max-w-2xl">
      <div class="grid grid-cols-2 gap-4">
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Nombre de la empresa</label><input id="co-name" value="${cfg.name||''}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">CUIT</label><input id="co-cuit" value="${cfg.cuit||''}" class="ing-input w-full mt-1" /></div>
        <div class="col-span-2"><label class="text-xs font-bold text-[#7d6c5c] uppercase">Domicilio fiscal</label><input id="co-addr" value="${cfg.address||''}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Teléfono</label><input id="co-phone" value="${cfg.phone||''}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Email</label><input id="co-email" type="email" value="${cfg.email||''}" class="ing-input w-full mt-1" /></div>
      </div>
      <div class="mt-5 text-right"><button id="co-save" class="ing-btn-primary">Guardar</button></div>
    </div>
  `;
  container.querySelector('#co-save').addEventListener('click', async () => {
    const value = {
      name: container.querySelector('#co-name').value,
      cuit: container.querySelector('#co-cuit').value,
      address: container.querySelector('#co-addr').value,
      phone: container.querySelector('#co-phone').value,
      email: container.querySelector('#co-email').value,
    };
    await put('config', { key: 'company', value });
    await Audit.log({ action: 'update', entity: 'config', entity_id: 'company', after: value, description: 'Datos de empresa actualizados' });
    toast('Guardado', 'success');
  });
}

// ===== SUCURSALES =====
async function renderBranches(container) {
  const branches = await getAll('branches');
  container.innerHTML = `
    <div class="flex justify-end mb-3"><button id="br-new" class="ing-btn-primary flex items-center gap-2"><span class="material-symbols-outlined text-base">add</span> Nueva sucursal</button></div>
    <div class="ing-card overflow-hidden">
      <table class="ing-table w-full">
        <thead><tr><th>Nombre</th><th>Dirección</th><th>Teléfono</th><th></th></tr></thead>
        <tbody>
          ${branches.map(b => `
            <tr>
              <td class="font-bold">${b.name}</td>
              <td class="text-sm">${b.address || '—'}</td>
              <td class="text-sm">${b.phone || '—'}</td>
              <td class="text-right">
                <button data-ed="${b.id}" class="text-xs text-[#d82f1e] hover:underline">Editar</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
  container.querySelector('#br-new').addEventListener('click', () => editBranch(container, null));
  container.querySelectorAll('[data-ed]').forEach(b => b.addEventListener('click', () => editBranch(container, branches.find(x => x.id === b.dataset.ed))));
}

async function editBranch(container, existing) {
  const isNew = !existing;
  const b = existing || { id: newId('br'), name: '', address: '', phone: '' };
  await openModal({
    title: isNew ? 'Nueva sucursal' : 'Editar sucursal',
    size: 'sm',
    bodyHTML: `
      <div class="space-y-3">
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Nombre</label><input id="b-name" value="${b.name||''}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Dirección</label><input id="b-addr" value="${b.address||''}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Teléfono</label><input id="b-phone" value="${b.phone||''}" class="ing-input w-full mt-1" /></div>
      </div>
    `,
    footerHTML: `<button class="ing-btn-secondary" data-act="cancel">Cancelar</button><button class="ing-btn-primary" data-act="ok">${isNew?'Crear':'Guardar'}</button>`,
    onOpen: (m, close) => {
      m.querySelector('[data-act="cancel"]').addEventListener('click', () => close(false));
      m.querySelector('[data-act="ok"]').addEventListener('click', async () => {
        b.name = m.querySelector('#b-name').value.trim();
        b.address = m.querySelector('#b-addr').value.trim();
        b.phone = m.querySelector('#b-phone').value.trim();
        if (!b.name) { toast('Nombre requerido', 'warn'); return; }
        await put('branches', b);
        toast('Guardado', 'success'); close(true);
      });
    },
  });
  renderBranches(container);
}

// ===== USUARIOS =====
async function renderUsers(container) {
  const [users, branches] = await Promise.all([getAll('users'), getAll('branches')]);
  const brMap = Object.fromEntries(branches.map(b => [b.id, b.name]));
  container.innerHTML = `
    <div class="flex justify-end mb-3"><button id="us-new" class="ing-btn-primary flex items-center gap-2"><span class="material-symbols-outlined text-base">add</span> Nuevo usuario</button></div>
    <div class="ing-card overflow-hidden">
      <table class="ing-table w-full">
        <thead><tr><th>Nombre</th><th>Sucursal</th><th>Rol</th><th>PIN</th><th></th></tr></thead>
        <tbody>
          ${users.map(u => `
            <tr>
              <td class="font-bold">${u.name} ${u.lastname || ''}</td>
              <td>${brMap[u.branch_id] || '—'}</td>
              <td><span class="text-xs px-2 py-1 rounded-full bg-[#fff1e6] uppercase font-bold">${u.role}</span></td>
              <td class="font-mono">****</td>
              <td class="text-right">
                <button data-ed="${u.id}" class="text-xs text-[#d82f1e] hover:underline">Editar</button>
                <button data-del="${u.id}" class="text-xs text-[#7d6c5c] hover:text-red-600 ml-1">Borrar</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
  container.querySelector('#us-new').addEventListener('click', () => editUser(container, null, branches));
  container.querySelectorAll('[data-ed]').forEach(b => b.addEventListener('click', () => editUser(container, users.find(x => x.id === b.dataset.ed), branches)));
  container.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    const ok = await confirmModal({ title: 'Borrar', message: '¿Eliminar usuario?', danger: true, confirmLabel: 'Borrar' });
    if (!ok) return;
    await del('users', b.dataset.del);
    toast('Eliminado', 'success'); renderUsers(container);
  }));
}

async function editUser(container, existing, branches) {
  const isNew = !existing;
  const u = existing ? { ...existing } : { id: newId('usr'), name: '', lastname: '', role: 'seller', branch_id: branches[0]?.id || '' };
  await openModal({
    title: isNew ? 'Nuevo usuario' : 'Editar usuario',
    size: 'sm',
    bodyHTML: `
      <div class="grid grid-cols-2 gap-3">
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Nombre</label><input id="u-name" value="${u.name||''}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Apellido</label><input id="u-last" value="${u.lastname||''}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Sucursal</label>
          <select id="u-br" class="ing-input w-full mt-1">${branches.map(b => `<option value="${b.id}" ${u.branch_id===b.id?'selected':''}>${b.name}</option>`).join('')}</select>
        </div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Rol</label>
          <select id="u-role" class="ing-input w-full mt-1">
            <option value="admin" ${u.role==='admin'?'selected':''}>Admin</option>
            <option value="manager" ${u.role==='manager'?'selected':''}>Manager</option>
            <option value="seller" ${u.role==='seller'?'selected':''}>Vendedor</option>
          </select>
        </div>
        <div class="col-span-2"><label class="text-xs font-bold text-[#7d6c5c] uppercase">PIN (4 dígitos)</label><input id="u-pin" type="password" maxlength="6" placeholder="${isNew ? 'Ingresar PIN' : 'Dejar vacío para no cambiar'}" class="ing-input w-full mt-1" /></div>
      </div>
    `,
    footerHTML: `<button class="ing-btn-secondary" data-act="cancel">Cancelar</button><button class="ing-btn-primary" data-act="ok">${isNew?'Crear':'Guardar'}</button>`,
    onOpen: (m, close) => {
      m.querySelector('[data-act="cancel"]').addEventListener('click', () => close(false));
      m.querySelector('[data-act="ok"]').addEventListener('click', async () => {
        u.name = m.querySelector('#u-name').value.trim();
        if (!u.name) { toast('Nombre requerido', 'warn'); return; }
        u.lastname = m.querySelector('#u-last').value.trim();
        u.branch_id = m.querySelector('#u-br').value;
        u.role = m.querySelector('#u-role').value;
        const pinVal = m.querySelector('#u-pin').value;
        if (isNew && !pinVal) { toast('PIN requerido', 'warn'); return; }
        if (pinVal) {
          const derived = await derivePin(pinVal);
          Object.assign(u, derived);
          delete u.pin; // por si venía legacy
        }
        await put('users', u);
        toast('Guardado', 'success'); close(true);
      });
    },
  });
  renderUsers(container);
}

// ===== PAYMENTS =====
async function renderPayments(container) {
  const cfg = await get('config', 'payment_methods');
  const methods = cfg?.value || [];
  container.innerHTML = `
    <div class="flex justify-between items-center mb-3">
      <p class="text-sm text-[#7d6c5c]">Los métodos con "afecta caja" impactan el saldo en efectivo al cobrar.</p>
      <button id="pm-new" class="ing-btn-primary flex items-center gap-2"><span class="material-symbols-outlined text-base">add</span> Nuevo método</button>
    </div>
    <div class="ing-card overflow-hidden">
      <table class="ing-table w-full">
        <thead><tr><th>Nombre</th><th>ID</th><th>Ícono</th><th class="text-right">Recargo %</th><th>Afecta caja</th><th></th></tr></thead>
        <tbody>
          ${methods.map((m, i) => `
            <tr>
              <td class="font-bold">${m.name}</td>
              <td class="font-mono text-xs">${m.id}</td>
              <td><span class="material-symbols-outlined text-[#d82f1e]">${m.icon}</span></td>
              <td class="text-right">${m.surcharge_pct || 0}%</td>
              <td>${m.affects_cash ? '<span class="text-green-700 text-xs font-bold">SÍ</span>' : '<span class="text-[#7d6c5c] text-xs">NO</span>'}</td>
              <td class="text-right">
                <button data-ed="${i}" class="text-xs text-[#d82f1e] hover:underline">Editar</button>
                <button data-del="${i}" class="text-xs text-[#7d6c5c] hover:text-red-600 ml-1">Borrar</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
  container.querySelector('#pm-new').addEventListener('click', () => editMethod(container, methods, null));
  container.querySelectorAll('[data-ed]').forEach(b => b.addEventListener('click', () => editMethod(container, methods, Number(b.dataset.ed))));
  container.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    const ok = await confirmModal({ title: 'Borrar', message: '¿Eliminar método de pago?', danger: true, confirmLabel: 'Borrar' });
    if (!ok) return;
    methods.splice(Number(b.dataset.del), 1);
    await put('config', { key: 'payment_methods', value: methods });
    toast('Eliminado', 'success'); renderPayments(container);
  }));
}

async function editMethod(container, methods, index) {
  const isNew = index === null;
  const m = isNew ? { id: '', name: '', icon: 'payments', surcharge_pct: 0, affects_cash: false } : { ...methods[index] };
  await openModal({
    title: isNew ? 'Nuevo método' : 'Editar método',
    size: 'sm',
    bodyHTML: `
      <div class="space-y-3">
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">ID (interno)</label><input id="pm-id" value="${m.id}" ${isNew?'':'disabled'} class="ing-input w-full mt-1" placeholder="ej: tarjeta_credito" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Nombre visible</label><input id="pm-name" value="${m.name}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Ícono (Material Symbols)</label><input id="pm-icon" value="${m.icon}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Recargo %</label><input id="pm-sur" type="number" value="${m.surcharge_pct || 0}" class="ing-input w-full mt-1" /></div>
        <label class="flex items-center gap-2"><input id="pm-ac" type="checkbox" ${m.affects_cash?'checked':''} /> <span class="text-sm">Afecta caja (entra al efvo disponible)</span></label>
      </div>
    `,
    footerHTML: `<button class="ing-btn-secondary" data-act="cancel">Cancelar</button><button class="ing-btn-primary" data-act="ok">${isNew?'Crear':'Guardar'}</button>`,
    onOpen: (el, close) => {
      el.querySelector('[data-act="cancel"]').addEventListener('click', () => close(false));
      el.querySelector('[data-act="ok"]').addEventListener('click', async () => {
        const updated = {
          id: isNew ? (el.querySelector('#pm-id').value.trim() || newId('pm')) : m.id,
          name: el.querySelector('#pm-name').value.trim(),
          icon: el.querySelector('#pm-icon').value.trim() || 'payments',
          surcharge_pct: Number(el.querySelector('#pm-sur').value) || 0,
          affects_cash: el.querySelector('#pm-ac').checked,
        };
        if (!updated.name) { toast('Nombre requerido', 'warn'); return; }
        if (isNew) methods.push(updated);
        else methods[index] = updated;
        await put('config', { key: 'payment_methods', value: methods });
        toast('Guardado', 'success'); close(true);
      });
    },
  });
  renderPayments(container);
}

// ===== SYSTEM =====
async function renderSystem(container) {
  const cnCfg = (await get('config', 'credit_note_months'))?.value || 6;
  const bkp = await checkBackupReminder();
  container.innerHTML = `
    <div class="ing-card p-5 max-w-2xl">
      <h3 class="font-black text-lg mb-3">Parámetros del sistema</h3>
      <div class="grid grid-cols-2 gap-4">
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Validez de vales (meses)</label><input id="sy-cn" type="number" value="${cnCfg}" min="1" max="36" class="ing-input w-full mt-1" /></div>
      </div>
      <div class="mt-5 text-right"><button id="sy-save" class="ing-btn-primary">Guardar</button></div>
    </div>

    <div class="ing-card p-5 max-w-2xl mt-4">
      <h3 class="font-black text-lg mb-1">Backup y restore</h3>
      <p class="text-sm text-[#7d6c5c] mb-3">
        Exportá todos los datos a un archivo JSON. Guardalo en un pendrive o drive — si el navegador borra los datos del sitio, es la única forma de recuperar.
        ${bkp.lastAt ? `<br><span class="text-xs">Último backup hace ${bkp.daysSince} día(s).</span>` : '<br><span class="text-xs text-red-600 font-bold">Nunca hiciste backup.</span>'}
      </p>
      <div class="flex gap-3 flex-wrap">
        <button id="bk-export" class="ing-btn-primary flex items-center gap-2"><span class="material-symbols-outlined text-base">download</span> Exportar backup</button>
        <label class="ing-btn-secondary flex items-center gap-2 cursor-pointer">
          <span class="material-symbols-outlined text-base">upload</span> Importar backup
          <input id="bk-import" type="file" accept="application/json" class="hidden" />
        </label>
      </div>
    </div>

    <div class="ing-card p-5 max-w-2xl mt-4">
      <h3 class="font-black text-lg mb-1">Integridad del audit log</h3>
      <p class="text-sm text-[#7d6c5c] mb-3">Verifica la cadena de hashes del historial para detectar modificaciones manuales.</p>
      <div class="flex items-center gap-3">
        <button id="au-verify" class="ing-btn-secondary flex items-center gap-2"><span class="material-symbols-outlined text-base">verified</span> Verificar cadena</button>
        <span id="au-result" class="text-sm text-[#7d6c5c]"></span>
      </div>
    </div>
  `;
  container.querySelector('#sy-save').addEventListener('click', async () => {
    const v = Number(container.querySelector('#sy-cn').value) || 6;
    await put('config', { key: 'credit_note_months', value: v });
    toast('Guardado', 'success');
  });

  container.querySelector('#bk-export').addEventListener('click', async () => {
    try {
      await exportBackup({ download: true });
      markBackupNow();
      toast('Backup descargado', 'success');
    } catch (e) { toast('Error: ' + e.message, 'error'); }
  });

  container.querySelector('#bk-import').addEventListener('change', async (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    const ok = await confirmModal({
      title: 'Importar backup',
      message: `Esto va a REEMPLAZAR todos los datos actuales con los del archivo "${file.name}". ¿Confirmás?`,
      danger: true, confirmLabel: 'Sí, restaurar',
    });
    if (!ok) { ev.target.value = ''; return; }
    try {
      const res = await importBackup(file, { wipe: true });
      toast(`${res.imported} registros importados`, 'success');
      setTimeout(() => location.reload(), 800);
    } catch (e) { toast('Error: ' + e.message, 'error'); }
    ev.target.value = '';
  });

  container.querySelector('#au-verify').addEventListener('click', async () => {
    const out = container.querySelector('#au-result');
    out.textContent = 'Verificando…';
    const res = await verifyChain();
    if (res.ok) {
      out.innerHTML = `<span class="text-green-700 font-bold">✓ Cadena íntegra · ${res.total} entradas</span>`;
    } else {
      out.innerHTML = `<span class="text-red-600 font-bold">✗ Cadena rota en entrada #${res.brokenAt} (${res.reason})</span>`;
    }
  });
}

// ===== DANGER =====
async function renderDanger(container) {
  container.innerHTML = `
    <div class="ing-card p-5 border-red-200 border-2">
      <h3 class="font-black text-lg mb-3 text-red-600">Zona peligrosa</h3>
      <p class="text-sm text-[#7d6c5c] mb-4">Estas acciones son destructivas y no se pueden deshacer.</p>
      <div class="flex gap-3 flex-wrap">
        <button id="reset-btn" class="px-4 py-2 rounded-full bg-red-50 text-red-600 font-bold text-sm hover:bg-red-100">Reiniciar sistema</button>
        <button id="logout-btn" class="ing-btn-secondary">Cerrar sesión</button>
      </div>
    </div>
  `;
  container.querySelector('#reset-btn').addEventListener('click', async () => {
    const ok = await confirmModal({ title: 'Reiniciar sistema', message: 'Esto borra TODOS los datos (ventas, productos, stock, clientes, caja, audit) y vuelve al estado inicial. ¿Confirmás?', confirmLabel: 'Sí, reiniciar', danger: true });
    if (!ok) return;
    await resetAllData();
    await runSeed({ force: true });
    toast('Sistema reiniciado', 'success');
    setTimeout(() => location.reload(), 600);
  });
  container.querySelector('#logout-btn').addEventListener('click', () => logout());
}
