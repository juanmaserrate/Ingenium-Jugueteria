// Configuración — empresa, sucursales, usuarios, métodos de pago, reinicio de sistema.

import { get, getAll, put, del, newId } from '../core/db.js';
import { resetAllData, runSeed } from '../core/seed.js';
import { openModal, confirmModal } from '../components/modal.js';
import { toast } from '../core/notifications.js';
import { logout } from '../core/auth.js';
import * as Audit from '../core/audit.js';
import { derivePin } from '../core/crypto.js';
import { api, ApiError } from '../core/api.js';
import * as Settings from '../repos/settings.js';
import * as Kv from '../repos/kv.js';
import { money } from '../core/format.js';
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
      ${tabBtn('promos', 'Promos y costos', 'sell')}
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
  if (state.tab === 'promos') await renderPromos(c);
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
  const cfg = (await Settings.getConfig('company', null)) || { name: '', cuit: '', address: '', phone: '', email: '' };
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
    <div class="ing-card p-5 max-w-2xl mt-4">
      <div class="text-sm font-black text-[#241a0d]">Migrar datos locales al servidor</div>
      <p class="text-xs text-[#7d6c5c] mt-1">Sube al servidor lo que haya quedado guardado solo en esta PC (cheques, tareas, calendario, notificaciones, costos). Corré esto en cada PC que haya usado esos módulos.</p>
      <div class="mt-3"><button id="co-migrate" class="ing-btn-secondary text-sm">Migrar datos locales</button> <span id="co-migrate-res" class="text-xs text-[#7d6c5c] ml-2"></span></div>
    </div>
  `;
  container.querySelector('#co-migrate').addEventListener('click', async (ev) => {
    ev.currentTarget.disabled = true;
    const out = container.querySelector('#co-migrate-res');
    let total = 0;
    for (const col of ['checks', 'tasks', 'calendar_events', 'notifications', 'monthly_pnl']) {
      try { total += await Kv.migrateFromLocal(col); } catch { /* seguir */ }
    }
    out.textContent = `${total} registro(s) migrado(s)`;
    toast(`Migrados ${total} registro(s) al servidor`, 'success');
  });
  container.querySelector('#co-save').addEventListener('click', async () => {
    const value = {
      name: container.querySelector('#co-name').value,
      cuit: container.querySelector('#co-cuit').value,
      address: container.querySelector('#co-addr').value,
      phone: container.querySelector('#co-phone').value,
      email: container.querySelector('#co-email').value,
    };
    await Settings.setConfig('company', value);
    await Audit.log({ action: 'update', entity: 'config', entity_id: 'company', after: value, description: 'Datos de empresa actualizados' });
    toast('Guardado', 'success');
  });
}

// ===== SUCURSALES =====
async function renderBranches(container) {
  // Sucursales del servidor (compartidas). Fallback local si no hay conexión.
  let branches;
  try { branches = await api('/api/branches'); }
  catch { branches = await getAll('branches'); }
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
                <button data-del="${b.id}" class="text-xs text-[#7d6c5c] hover:text-red-600 ml-1">Borrar</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
  container.querySelector('#br-new').addEventListener('click', () => editBranch(container, null));
  container.querySelectorAll('[data-ed]').forEach(b => b.addEventListener('click', () => editBranch(container, branches.find(x => x.id === b.dataset.ed))));
  container.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    const ok = await confirmModal({ title: 'Borrar sucursal', message: '¿Eliminar la sucursal? Solo se puede si no tiene datos asociados.', danger: true, confirmLabel: 'Borrar' });
    if (!ok) return;
    try { await api(`/api/branches/${encodeURIComponent(b.dataset.del)}`, { method: 'DELETE' }); toast('Sucursal eliminada', 'success'); renderBranches(container); }
    catch (e) { toast(e?.message || 'No se pudo eliminar', 'error'); }
  }));
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
        try {
          const body = { name: b.name, address: b.address || null, phone: b.phone || null };
          if (isNew) await api('/api/branches', { method: 'POST', body });
          else await api(`/api/branches/${encodeURIComponent(b.id)}`, { method: 'PUT', body });
          toast('Guardado', 'success'); close(true);
        } catch (e) { toast(e?.message || 'No se pudo guardar', 'error'); }
      });
    },
  });
  renderBranches(container);
}

// ===== USUARIOS =====
async function renderUsers(container) {
  const branches = await getAll('branches');
  // Usuarios del backend (compartidos entre PC). Fallback local si no hay conexión.
  let users;
  try {
    const be = await api('/auth/users');
    users = (be || []).map(u => ({ ...u, branch_id: u.branchId ?? u.branch_id }));
  } catch {
    users = await getAll('users');
  }
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
    const userId = b.dataset.del;
    await del('users', userId);
    try { await api(`/auth/users/${encodeURIComponent(userId)}/deactivate`, { method: 'POST' }); }
    catch (e) { if (!(e instanceof ApiError) || e.status !== 0) console.warn('backend deactivate falló', e); }
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
            <option value="admin" ${u.role==='admin'?'selected':''}>Administrador</option>
            <option value="encargado" ${u.role==='encargado'?'selected':''}>Encargado</option>
            ${u.role==='manager' ? '<option value="manager" selected>Manager (legacy)</option>' : ''}
            ${u.role==='seller' ? '<option value="seller" selected>Vendedor (legacy)</option>' : ''}
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
        // Sync al backend para mantener login-pin operativo. Offline es tolerable:
        // al reconectar, reabrir y guardar el usuario vuelve a empujarlo.
        let msg = 'Guardado', kind = 'success';
        try {
          await api('/auth/users/sync', {
            method: 'POST',
            body: {
              id: u.id,
              branch_id: u.branch_id,
              name: u.name,
              lastname: u.lastname || '',
              role: u.role,
              pin_salt: u.pin_salt,
              pin_hash: u.pin_hash,
              pin_iters: u.pin_iters,
              active: u.active !== false,
            },
          });
        } catch (e) {
          if (e instanceof ApiError && e.status === 0) { msg = 'Guardado local (offline)'; kind = 'info'; }
          else { console.warn('backend sync falló', e); msg = 'Guardado local — sync backend falló'; kind = 'warn'; }
        }
        toast(msg, kind); close(true);
      });
    },
  });
  renderUsers(container);
}

// ===== PAYMENTS =====
async function renderPayments(container) {
  const methods = (await Settings.getConfig('payment_methods', [])) || [];
  // Medios de pago que quedaron guardados solo en esta PC (config local, antes del fix).
  const localMethods = ((await get('config', 'payment_methods'))?.value) || [];
  const canImportLocal = methods.length === 0 && localMethods.length > 0;
  container.innerHTML = `
    ${canImportLocal ? `
    <div class="ing-card p-3 mb-3 border-l-4 border-amber-500 bg-amber-50 flex items-center justify-between gap-3 flex-wrap">
      <div class="text-sm text-[#241a0d]"><b>${localMethods.length} medio(s) de pago</b> quedaron guardados solo en esta PC. Importalos al servidor para compartirlos entre sucursales.</div>
      <button id="pm-migrate" class="ing-btn-primary !py-1.5 !px-3 text-sm shrink-0">Importar al servidor</button>
    </div>` : ''}
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
  container.querySelector('#pm-migrate')?.addEventListener('click', async (ev) => {
    ev.currentTarget.disabled = true;
    try {
      await Settings.setConfig('payment_methods', localMethods);
      // Importar también empresa y config de vales si están solo en local.
      const localCompany = (await get('config', 'company'))?.value;
      if (localCompany) await Settings.setConfig('company', localCompany);
      const localCn = (await get('config', 'credit_note_months'))?.value;
      if (localCn != null) await Settings.setConfig('credit_note_months', localCn);
      toast('Medios de pago importados al servidor', 'success');
      renderPayments(container);
    } catch (e) { toast(e?.message || 'No se pudo importar', 'error'); }
  });
  container.querySelector('#pm-new').addEventListener('click', () => editMethod(container, methods, null));
  container.querySelectorAll('[data-ed]').forEach(b => b.addEventListener('click', () => editMethod(container, methods, Number(b.dataset.ed))));
  container.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    const ok = await confirmModal({ title: 'Borrar', message: '¿Eliminar método de pago?', danger: true, confirmLabel: 'Borrar' });
    if (!ok) return;
    const removed = methods.splice(Number(b.dataset.del), 1);
    try {
      await Settings.setConfig('payment_methods', methods);
      toast('Eliminado', 'success');
    } catch (e) {
      methods.splice(Number(b.dataset.del), 0, ...removed); // revertir si falló
      toast(e?.message || 'No se pudo eliminar', 'error');
    }
    renderPayments(container);
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
        const prev = isNew ? null : methods[index];
        if (isNew) methods.push(updated);
        else methods[index] = updated;
        try {
          await Settings.setConfig('payment_methods', methods);
          toast('Guardado', 'success'); close(true);
        } catch (e) {
          // revertir el cambio optimista si el guardado falló (ej: sin permiso)
          if (isNew) methods.pop(); else methods[index] = prev;
          toast(e?.message || 'No se pudo guardar el método de pago', 'error');
        }
      });
    },
  });
  renderPayments(container);
}

// ===== PROMOS Y COSTOS =====
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const curMonthKey = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const prevMonthKey = (k) => { let [y, m] = k.split('-').map(Number); m--; if (m < 1) { m = 12; y--; } return `${y}-${String(m).padStart(2, '0')}`; };
const DIAS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

async function renderPromos(container) {
  if (!state.promoMonth) state.promoMonth = curMonthKey();
  const month = state.promoMonth;
  const acquirers = (await Settings.getConfig('acquirers', [])) || [];
  const payMethods = (await Settings.getConfig('payment_methods', [])) || [];
  const promosAll = (await Settings.getConfig('promos', {})) || {};
  const promos = promosAll[month] || [];
  const acqName = (id) => (acquirers.find((a) => a.id === id)?.name) || '—';
  const methodName = (id) => (payMethods.find((m) => m.id === id)?.name) || '—';

  container.innerHTML = `
    <div class="ing-card p-4 mb-5">
      <div class="flex justify-between items-center mb-3 gap-2 flex-wrap">
        <div><h3 class="font-black text-lg">Adquirentes / Gateways</h3>
          <p class="text-xs text-[#7d6c5c]">Terminales del local y pasarelas online, con comisiones y plazos. Compartido entre sucursales.</p></div>
        <button id="aq-new" class="ing-btn-primary flex items-center gap-2 !py-1.5"><span class="material-symbols-outlined text-base">add</span> Nuevo</button>
      </div>
      <div class="overflow-x-auto"><table class="ing-table w-full text-sm">
        <thead><tr><th>Nombre</th><th>Tipo</th><th class="text-right">Débito%</th><th class="text-right">Crédito%</th><th>Cuotas 3/6/12</th><th class="text-right">Acred. d/c/ctas</th><th class="text-right">Fijo/mes</th><th>Plataforma TN%</th><th>Activo</th><th></th></tr></thead>
        <tbody>${acquirers.length ? acquirers.map((a, i) => `
          <tr>
            <td class="font-bold">${esc(a.name)}</td><td>${a.kind === 'online' ? 'Online' : 'Local'}</td>
            <td class="text-right">${a.debit_pct || 0}</td><td class="text-right">${a.credit_pct || 0}</td>
            <td>${a.fin3 || 0}/${a.fin6 || 0}/${a.fin12 || 0}</td>
            <td class="text-right">${a.days_debit || 0}/${a.days_credit || 0}/${a.days_cuotas || 0}</td>
            <td class="text-right">${money(a.fixed_monthly || 0)}</td><td class="text-right">${a.tn_platform_pct || 0}</td>
            <td>${a.active !== false ? '<span class="text-green-700 text-xs font-bold">SÍ</span>' : '<span class="text-[#7d6c5c] text-xs">NO</span>'}</td>
            <td class="text-right whitespace-nowrap"><button data-aqed="${i}" class="text-xs text-[#d82f1e] hover:underline">Editar</button> <button data-aqdel="${i}" class="text-xs text-[#7d6c5c] hover:text-red-600 ml-1">Borrar</button></td>
          </tr>`).join('') : '<tr><td colspan="10" class="text-center text-[#7d6c5c] py-4">Sin adquirentes. Cargá tus terminales y gateways.</td></tr>'}</tbody>
      </table></div>
    </div>

    <div class="ing-card p-4">
      <div class="flex justify-between items-center mb-3 flex-wrap gap-2">
        <div><h3 class="font-black text-lg">Promos del mes</h3>
          <p class="text-xs text-[#7d6c5c]">Promos bancarias por mes. Se congelan en cada venta → los reportes viejos quedan exactos.</p></div>
        <div class="flex items-center gap-2 flex-wrap">
          <input id="pr-month" type="month" value="${month}" class="ing-input !py-1.5 text-sm" />
          <button id="pr-clone" class="ing-btn-secondary !py-1.5 text-sm">Traer del mes anterior</button>
          <button id="pr-new" class="ing-btn-primary flex items-center gap-2 !py-1.5"><span class="material-symbols-outlined text-base">add</span> Nueva promo</button>
        </div>
      </div>
      <div class="overflow-x-auto"><table class="ing-table w-full text-sm">
        <thead><tr><th>Nombre</th><th>Forma de pago</th><th>Banco</th><th>Adquirente</th><th class="text-right">Cuotas</th><th class="text-right">Desc.</th><th>Paga</th><th>Tope</th><th>Activa</th><th></th></tr></thead>
        <tbody>${promos.length ? promos.map((p, i) => `
          <tr>
            <td class="font-bold">${esc(p.name)}</td>
            <td>${p.method_id ? esc(methodName(p.method_id)) : '<span class="text-amber-600 text-xs font-bold">sin asignar</span>'}</td>
            <td>${esc(p.bank || '—')}</td><td>${esc(acqName(p.acquirer_id))}</td>
            <td class="text-right">${p.installments || 1}</td><td class="text-right">${p.discount_pct || 0}%</td>
            <td>${p.discount_funder === 'comercio' ? 'Comercio' : 'Banco'}</td>
            <td>${p.tope_amount ? `${money(p.tope_amount)} · ${p.tope_mode === 'aplicado' ? 'aplicado' : 'info'}` : '—'}</td>
            <td>${p.active !== false ? '<span class="text-green-700 text-xs font-bold">SÍ</span>' : '<span class="text-[#7d6c5c] text-xs">NO</span>'}</td>
            <td class="text-right whitespace-nowrap"><button data-pred="${i}" class="text-xs text-[#d82f1e] hover:underline">Editar</button> <button data-prdel="${i}" class="text-xs text-[#7d6c5c] hover:text-red-600 ml-1">Borrar</button></td>
          </tr>`).join('') : '<tr><td colspan="10" class="text-center text-[#7d6c5c] py-4">Sin promos para este mes. Creá una o traé las del mes anterior.</td></tr>'}</tbody>
      </table></div>
    </div>
  `;

  container.querySelector('#aq-new').addEventListener('click', () => editAcquirer(container, acquirers, null));
  container.querySelectorAll('[data-aqed]').forEach((b) => b.addEventListener('click', () => editAcquirer(container, acquirers, Number(b.dataset.aqed))));
  container.querySelectorAll('[data-aqdel]').forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmModal({ title: 'Borrar', message: '¿Eliminar adquirente?', danger: true, confirmLabel: 'Borrar' }))) return;
    acquirers.splice(Number(b.dataset.aqdel), 1);
    try { await Settings.setConfig('acquirers', acquirers); toast('Eliminado', 'success'); } catch (e) { toast(e?.message || 'No se pudo', 'error'); }
    renderPromos(container);
  }));

  container.querySelector('#pr-month').addEventListener('change', (ev) => { state.promoMonth = ev.target.value || curMonthKey(); renderPromos(container); });
  container.querySelector('#pr-clone').addEventListener('click', async () => {
    const prev = promosAll[prevMonthKey(month)] || [];
    if (!prev.length) { toast(`El mes anterior (${prevMonthKey(month)}) no tiene promos`, 'warn'); return; }
    if ((promosAll[month] || []).length && !(await confirmModal({ title: 'Traer del mes anterior', message: `Este mes ya tiene ${promosAll[month].length} promo(s). Se van a AGREGAR ${prev.length} del mes anterior. ¿Seguir?`, confirmLabel: 'Traer' }))) return;
    promosAll[month] = [...(promosAll[month] || []), ...prev.map((p) => ({ ...p, id: newId('promo') }))];
    try { await Settings.setConfig('promos', promosAll); toast(`${prev.length} promo(s) traídas`, 'success'); } catch (e) { toast(e?.message || 'No se pudo', 'error'); }
    renderPromos(container);
  });
  container.querySelector('#pr-new').addEventListener('click', () => editPromo(container, promosAll, month, acquirers, payMethods, null));
  container.querySelectorAll('[data-pred]').forEach((b) => b.addEventListener('click', () => editPromo(container, promosAll, month, acquirers, payMethods, Number(b.dataset.pred))));
  container.querySelectorAll('[data-prdel]').forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmModal({ title: 'Borrar', message: '¿Eliminar promo?', danger: true, confirmLabel: 'Borrar' }))) return;
    promosAll[month].splice(Number(b.dataset.prdel), 1);
    try { await Settings.setConfig('promos', promosAll); toast('Eliminada', 'success'); } catch (e) { toast(e?.message || 'No se pudo', 'error'); }
    renderPromos(container);
  }));
}

async function editAcquirer(container, acquirers, index) {
  const isNew = index === null;
  const a = isNew ? { id: '', name: '', kind: 'local', debit_pct: 0, credit_pct: 0, fin3: 0, fin6: 0, fin12: 0, days_debit: 2, days_credit: 10, days_cuotas: 2, fixed_monthly: 0, tn_platform_pct: 0, active: true } : { ...acquirers[index] };
  const num = (id) => Number(document.querySelector(id)?.value) || 0;
  await openModal({
    title: isNew ? 'Nuevo adquirente / gateway' : 'Editar adquirente',
    size: 'md',
    bodyHTML: `
      <div class="grid grid-cols-2 gap-3">
        <div class="col-span-2"><label class="text-xs font-bold text-[#7d6c5c] uppercase">Nombre</label><input id="aq-name" value="${esc(a.name)}" class="ing-input w-full mt-1" placeholder="ej: Posnet Galicia / Mercado Pago" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Tipo</label><select id="aq-kind" class="ing-input w-full mt-1"><option value="local" ${a.kind !== 'online' ? 'selected' : ''}>Local (terminal)</option><option value="online" ${a.kind === 'online' ? 'selected' : ''}>Online (gateway)</option></select></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Costo fijo mensual</label><input id="aq-fixed" type="number" value="${a.fixed_monthly || 0}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Comisión débito %</label><input id="aq-deb" type="number" step="0.01" value="${a.debit_pct || 0}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Comisión crédito % (1 pago)</label><input id="aq-cred" type="number" step="0.01" value="${a.credit_pct || 0}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Costo 3 cuotas %</label><input id="aq-f3" type="number" step="0.01" value="${a.fin3 || 0}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Costo 6 cuotas %</label><input id="aq-f6" type="number" step="0.01" value="${a.fin6 || 0}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Costo 12 cuotas %</label><input id="aq-f12" type="number" step="0.01" value="${a.fin12 || 0}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Comisión plataforma TN % (si aplica)</label><input id="aq-tn" type="number" step="0.01" value="${a.tn_platform_pct || 0}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Acreditación débito (días)</label><input id="aq-dd" type="number" value="${a.days_debit ?? 2}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Acreditación crédito 1 pago (días)</label><input id="aq-dc" type="number" value="${a.days_credit ?? 10}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Acreditación cuotas (días)</label><input id="aq-dq" type="number" value="${a.days_cuotas ?? 2}" class="ing-input w-full mt-1" /></div>
        <label class="col-span-2 flex items-center gap-2 mt-1"><input id="aq-active" type="checkbox" ${a.active !== false ? 'checked' : ''} /> <span class="text-sm">Activo</span></label>
      </div>`,
    footerHTML: `<button class="ing-btn-secondary" data-act="cancel">Cancelar</button><button class="ing-btn-primary" data-act="ok">${isNew ? 'Crear' : 'Guardar'}</button>`,
    onOpen: (el, close) => {
      el.querySelector('[data-act="cancel"]').addEventListener('click', () => close(false));
      el.querySelector('[data-act="ok"]').addEventListener('click', async () => {
        const name = el.querySelector('#aq-name').value.trim();
        if (!name) { toast('Nombre requerido', 'warn'); return; }
        const updated = {
          id: isNew ? newId('acq') : a.id, name, kind: el.querySelector('#aq-kind').value,
          debit_pct: num('#aq-deb'), credit_pct: num('#aq-cred'), fin3: num('#aq-f3'), fin6: num('#aq-f6'), fin12: num('#aq-f12'),
          tn_platform_pct: num('#aq-tn'), fixed_monthly: num('#aq-fixed'),
          days_debit: num('#aq-dd'), days_credit: num('#aq-dc'), days_cuotas: num('#aq-dq'),
          active: el.querySelector('#aq-active').checked,
        };
        if (isNew) acquirers.push(updated); else acquirers[index] = updated;
        try { await Settings.setConfig('acquirers', acquirers); toast('Guardado', 'success'); close(true); }
        catch (e) { if (isNew) acquirers.pop(); else acquirers[index] = a; toast(e?.message || 'No se pudo guardar', 'error'); }
      });
    },
  });
  renderPromos(container);
}

async function editPromo(container, promosAll, month, acquirers, payMethods, index) {
  const list = promosAll[month] || (promosAll[month] = []);
  const isNew = index === null;
  const p = isNew
    ? { id: '', name: '', method_id: '', bank: '', card_type: 'credito', acquirer_id: '', installments: 1, discount_pct: 0, discount_funder: 'banco', tope_amount: 0, tope_mode: 'informativo', valid_days: [], valid_from: '', valid_to: '', affects_cash: false, icon: 'credit_card', active: true }
    : { ...list[index] };
  const acqOpts = ['<option value="">(elegí adquirente)</option>'].concat(acquirers.map((a) => `<option value="${a.id}" ${p.acquirer_id === a.id ? 'selected' : ''}>${esc(a.name)}</option>`)).join('');
  const methodOpts = ['<option value="">(elegí forma de pago)</option>'].concat((payMethods || []).map((m) => `<option value="${m.id}" ${p.method_id === m.id ? 'selected' : ''}>${esc(m.name)}</option>`)).join('');
  const dayChecks = DIAS.map((d, i) => `<label class="flex items-center gap-1 text-xs"><input type="checkbox" class="pr-day" data-day="${i}" ${(p.valid_days || []).includes(i) ? 'checked' : ''} /> ${d}</label>`).join('');
  await openModal({
    title: isNew ? 'Nueva promo' : 'Editar promo',
    size: 'md',
    bodyHTML: `
      <div class="grid grid-cols-2 gap-3">
        <div class="col-span-2"><label class="text-xs font-bold text-[#7d6c5c] uppercase">Nombre visible</label><input id="pr-name" value="${esc(p.name)}" class="ing-input w-full mt-1" placeholder="ej: Cuenta DNI miércoles 6 cuotas" /></div>
        <div class="col-span-2"><label class="text-xs font-bold text-[#7d6c5c] uppercase">Forma de pago (a qué medio pertenece)</label><select id="pr-method" class="ing-input w-full mt-1">${methodOpts}</select><p class="text-[11px] text-[#7d6c5c] mt-1">En el POS, al elegir esta forma de pago aparece esta promo para seleccionar.</p></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Banco</label><input id="pr-bank" value="${esc(p.bank)}" class="ing-input w-full mt-1" placeholder="ej: Provincia" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Tarjeta / red</label><select id="pr-card" class="ing-input w-full mt-1">${['credito', 'debito', 'qr', 'otro'].map((t) => `<option value="${t}" ${p.card_type === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Adquirente / gateway</label><select id="pr-acq" class="ing-input w-full mt-1">${acqOpts}</select></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Cuotas</label><input id="pr-inst" type="number" min="1" value="${p.installments || 1}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Descuento %</label><input id="pr-disc" type="number" step="0.01" value="${p.discount_pct || 0}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Quién paga el descuento</label><select id="pr-funder" class="ing-input w-full mt-1"><option value="banco" ${p.discount_funder !== 'comercio' ? 'selected' : ''}>Banco (cobro full)</option><option value="comercio" ${p.discount_funder === 'comercio' ? 'selected' : ''}>Comercio (sale de mi margen)</option></select></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Tope $ (0 = sin tope)</label><input id="pr-tope" type="number" value="${p.tope_amount || 0}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Modo de tope</label><select id="pr-topemode" class="ing-input w-full mt-1"><option value="informativo" ${p.tope_mode !== 'aplicado' ? 'selected' : ''}>Informativo (lo controla el banco)</option><option value="aplicado" ${p.tope_mode === 'aplicado' ? 'selected' : ''}>Aplicado por el sistema</option></select></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Vigente desde</label><input id="pr-from" type="date" value="${p.valid_from || ''}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Vigente hasta</label><input id="pr-to" type="date" value="${p.valid_to || ''}" class="ing-input w-full mt-1" /></div>
        <div class="col-span-2"><label class="text-xs font-bold text-[#7d6c5c] uppercase">Días válidos (vacío = todos)</label><div class="flex gap-3 mt-1 flex-wrap">${dayChecks}</div></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Ícono</label><input id="pr-icon" value="${esc(p.icon || 'credit_card')}" class="ing-input w-full mt-1" /></div>
        <label class="flex items-center gap-2 mt-5"><input id="pr-ac" type="checkbox" ${p.affects_cash ? 'checked' : ''} /> <span class="text-sm">Afecta caja</span></label>
        <label class="col-span-2 flex items-center gap-2"><input id="pr-active" type="checkbox" ${p.active !== false ? 'checked' : ''} /> <span class="text-sm">Activa este mes</span></label>
      </div>`,
    footerHTML: `<button class="ing-btn-secondary" data-act="cancel">Cancelar</button><button class="ing-btn-primary" data-act="ok">${isNew ? 'Crear' : 'Guardar'}</button>`,
    onOpen: (el, close) => {
      el.querySelector('[data-act="cancel"]').addEventListener('click', () => close(false));
      el.querySelector('[data-act="ok"]').addEventListener('click', async () => {
        const name = el.querySelector('#pr-name').value.trim();
        if (!name) { toast('Nombre requerido', 'warn'); return; }
        const updated = {
          id: isNew ? newId('promo') : p.id, name,
          method_id: el.querySelector('#pr-method').value || '',
          bank: el.querySelector('#pr-bank').value.trim(), card_type: el.querySelector('#pr-card').value,
          acquirer_id: el.querySelector('#pr-acq').value, installments: Math.max(1, Number(el.querySelector('#pr-inst').value) || 1),
          discount_pct: Number(el.querySelector('#pr-disc').value) || 0, discount_funder: el.querySelector('#pr-funder').value,
          tope_amount: Number(el.querySelector('#pr-tope').value) || 0, tope_mode: el.querySelector('#pr-topemode').value,
          valid_from: el.querySelector('#pr-from').value || '', valid_to: el.querySelector('#pr-to').value || '',
          valid_days: [...el.querySelectorAll('.pr-day')].filter((c) => c.checked).map((c) => Number(c.dataset.day)),
          icon: el.querySelector('#pr-icon').value.trim() || 'credit_card',
          affects_cash: el.querySelector('#pr-ac').checked, active: el.querySelector('#pr-active').checked,
        };
        if (isNew) list.push(updated); else list[index] = updated;
        try { await Settings.setConfig('promos', promosAll); toast('Guardado', 'success'); close(true); }
        catch (e) { if (isNew) list.pop(); else list[index] = p; toast(e?.message || 'No se pudo guardar', 'error'); }
      });
    },
  });
  renderPromos(container);
}

// ===== SYSTEM =====
async function renderSystem(container) {
  const cnCfg = (await Settings.getConfig('credit_note_months', 6)) || 6;
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
    await Settings.setConfig('credit_note_months', v);
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
