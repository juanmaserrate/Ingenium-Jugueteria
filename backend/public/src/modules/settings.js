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
  const promosRaw = (await Settings.getConfig('promos', [])) || [];
  const promos = Array.isArray(promosRaw) ? promosRaw : Object.values(promosRaw).flat();
  // Medios de pago que quedaron guardados solo en esta PC (config local, antes del fix).
  const localMethods = ((await get('config', 'payment_methods'))?.value) || [];
  const canImportLocal = methods.length === 0 && localMethods.length > 0;
  const promosOf = (mid) => promos.filter((p) => p.method_id === mid);
  const costSummary = (m) => {
    const parts = [];
    if (Number(m.commission_pct) > 0) parts.push(`com. ${m.commission_pct}%`);
    if (m.kind === 'online' && Number(m.tn_platform_pct) > 0) parts.push(`plataforma ${m.tn_platform_pct}%`);
    if (Number(m.settle_days) > 0) parts.push(`acredita ${m.settle_days}d`);
    if (Number(m.surcharge_pct) > 0) parts.push(`recargo ${m.surcharge_pct}%`);
    return parts.join(' · ');
  };
  container.innerHTML = `
    ${canImportLocal ? `
    <div class="ing-card p-3 mb-3 border-l-4 border-amber-500 bg-amber-50 flex items-center justify-between gap-3 flex-wrap">
      <div class="text-sm text-[#241a0d]"><b>${localMethods.length} medio(s) de pago</b> quedaron guardados solo en esta PC. Importalos al servidor para compartirlos entre sucursales.</div>
      <button id="pm-migrate" class="ing-btn-primary !py-1.5 !px-3 text-sm shrink-0">Importar al servidor</button>
    </div>` : ''}
    <div class="flex justify-between items-center mb-3 flex-wrap gap-2">
      <p class="text-sm text-[#7d6c5c]">Cada forma de pago tiene su comisión/costo y sus promos. Tocá una para expandir y ver o cargar sus promos.</p>
      <button id="pm-new" class="ing-btn-primary flex items-center gap-2 shrink-0"><span class="material-symbols-outlined text-base">add</span> Nueva forma de pago</button>
    </div>
    <div class="space-y-2">
      ${methods.length ? methods.map((m, i) => {
        const prs = promosOf(m.id);
        return `
        <details class="ing-card overflow-hidden" ${state.openMethod === m.id ? 'open' : ''}>
          <summary class="flex items-center gap-3 p-3 cursor-pointer select-none list-none">
            <span class="material-symbols-outlined text-[#d82f1e]">${esc(m.icon || 'payments')}</span>
            <div class="flex-1 min-w-0">
              <div class="font-bold text-[#241a0d]">${esc(m.name)}</div>
              <div class="text-xs text-[#7d6c5c]">${costSummary(m) || 'sin costo configurado'}${prs.length ? ` · ${prs.length} promo(s)` : ''}</div>
            </div>
            ${m.affects_cash ? '<span class="text-green-700 text-xs font-bold">afecta caja</span>' : ''}
            ${m.kind === 'online' ? '<span class="text-blue-600 text-xs font-bold">online</span>' : ''}
            <button data-ed="${i}" class="text-xs text-[#d82f1e] hover:underline">Editar</button>
            <button data-del="${i}" class="text-xs text-[#7d6c5c] hover:text-red-600">Borrar</button>
          </summary>
          <div class="px-4 pb-4 border-t border-[#fff1e6]">
            <div class="flex items-center justify-between mt-3 mb-2">
              <div class="text-xs font-bold text-[#7d6c5c] uppercase">Promos de este medio</div>
              <button data-prnew="${esc(m.id)}" class="text-xs font-bold text-[#d82f1e] flex items-center gap-1"><span class="material-symbols-outlined text-sm">add</span> Agregar promo</button>
            </div>
            ${prs.length ? `<div class="space-y-1.5">${prs.map((pr) => {
              const gi = promos.indexOf(pr);
              return `
              <div class="flex items-center gap-2 bg-[#fff8f4] rounded-lg px-3 py-2">
                <div class="flex-1 min-w-0">
                  <div class="text-sm font-bold text-[#241a0d]">${esc(pr.name)}${pr.active === false ? ' <span class="text-[#7d6c5c] text-xs font-normal">(inactiva)</span>' : ''}</div>
                  <div class="text-xs text-[#7d6c5c]">${Number(pr.discount_pct) > 0 ? `${pr.discount_pct}% desc${Number(pr.tope_amount) > 0 ? ` (tope ${money(pr.tope_amount)})` : ' (sin tope)'}` : 'sin descuento'}${Number(pr.installments) > 1 ? ` · ${pr.installments} cuotas` : ''}</div>
                </div>
                <button data-pred="${gi}" class="text-xs text-[#d82f1e] hover:underline">Editar</button>
                <button data-prdel="${gi}" class="text-xs text-[#7d6c5c] hover:text-red-600">Borrar</button>
              </div>`;
            }).join('')}</div>` : '<p class="text-xs text-[#7d6c5c] py-1">Sin promos todavía. Agregá las promos bancarias que se pagan con este medio.</p>'}
          </div>
        </details>`;
      }).join('') : '<div class="ing-card p-6 text-center text-[#7d6c5c]">Sin formas de pago. Creá la primera (Efectivo, Débito, Crédito, QR…).</div>'}
    </div>
  `;
  // Mantener abierta la tarjeta que el usuario expandió (para que no se cierre al re-render).
  container.querySelectorAll('details').forEach((d, i) => d.addEventListener('toggle', () => {
    if (d.open) state.openMethod = methods[i]?.id || null;
    else if (state.openMethod === methods[i]?.id) state.openMethod = null;
  }));
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
  container.querySelectorAll('[data-ed]').forEach(b => b.addEventListener('click', (ev) => { ev.preventDefault(); editMethod(container, methods, Number(b.dataset.ed)); }));
  container.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async (ev) => {
    ev.preventDefault();
    const m = methods[Number(b.dataset.del)];
    const mine = promos.filter((p) => p.method_id === m.id);
    const ok = await confirmModal({ title: 'Borrar', message: `¿Eliminar "${m.name}"?${mine.length ? ` Se borran también sus ${mine.length} promo(s).` : ''}`, danger: true, confirmLabel: 'Borrar' });
    if (!ok) return;
    const removed = methods.splice(Number(b.dataset.del), 1);
    const promosKept = promos.filter((p) => p.method_id !== m.id);
    try {
      await Settings.setConfig('payment_methods', methods);
      if (mine.length) await Settings.setConfig('promos', promosKept);
      toast('Eliminado', 'success');
    } catch (e) {
      methods.splice(Number(b.dataset.del), 0, ...removed); // revertir si falló
      toast(e?.message || 'No se pudo eliminar', 'error');
    }
    renderPayments(container);
  }));
  // Promos anidadas
  container.querySelectorAll('[data-prnew]').forEach(b => b.addEventListener('click', (ev) => { ev.preventDefault(); state.openMethod = b.dataset.prnew; editPromo(container, methods, promos, b.dataset.prnew, null); }));
  container.querySelectorAll('[data-pred]').forEach(b => b.addEventListener('click', (ev) => { ev.preventDefault(); const gi = Number(b.dataset.pred); state.openMethod = promos[gi]?.method_id || null; editPromo(container, methods, promos, promos[gi]?.method_id, gi); }));
  container.querySelectorAll('[data-prdel]').forEach(b => b.addEventListener('click', async (ev) => {
    ev.preventDefault();
    const gi = Number(b.dataset.prdel);
    if (!(await confirmModal({ title: 'Borrar', message: `¿Eliminar la promo "${promos[gi]?.name || ''}"?`, danger: true, confirmLabel: 'Borrar' }))) return;
    state.openMethod = promos[gi]?.method_id || null;
    const removed = promos.splice(gi, 1);
    try { await Settings.setConfig('promos', promos); toast('Eliminada', 'success'); }
    catch (e) { promos.splice(gi, 0, ...removed); toast(e?.message || 'No se pudo', 'error'); }
    renderPayments(container);
  }));
}

async function editMethod(container, methods, index) {
  const isNew = index === null;
  const m = isNew
    ? { id: '', name: '', icon: 'payments', card_type: 'efectivo', kind: 'local', surcharge_pct: 0, affects_cash: true, commission_pct: 0, fin3: 0, fin6: 0, fin12: 0, settle_days: 0, settle_days_cuotas: 0, tn_platform_pct: 0 }
    : { ...methods[index] };
  const CARDS = [['efectivo', 'Efectivo'], ['debito', 'Débito'], ['credito', 'Crédito'], ['qr', 'QR / billetera'], ['transferencia', 'Transferencia'], ['otro', 'Otro']];
  const num = (id) => Number(document.querySelector(id)?.value) || 0;
  await openModal({
    title: isNew ? 'Nueva forma de pago' : 'Editar forma de pago',
    size: 'md',
    bodyHTML: `
      <div class="grid grid-cols-2 gap-3">
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Nombre visible</label><input id="pm-name" value="${esc(m.name)}" class="ing-input w-full mt-1" placeholder="ej: Crédito Galicia" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Tipo</label><select id="pm-card" class="ing-input w-full mt-1">${CARDS.map(([v, t]) => `<option value="${v}" ${m.card_type === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
        ${isNew ? `<div><label class="text-xs font-bold text-[#7d6c5c] uppercase">ID (interno)</label><input id="pm-id" value="" class="ing-input w-full mt-1" placeholder="auto" /></div>` : ''}
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Ícono (Material Symbols)</label><input id="pm-icon" value="${esc(m.icon)}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Recargo % al cliente</label><input id="pm-sur" type="number" step="0.01" value="${m.surcharge_pct || 0}" class="ing-input w-full mt-1" /></div>
        <label class="flex items-center gap-2 mt-5"><input id="pm-ac" type="checkbox" ${m.affects_cash ? 'checked' : ''} /> <span class="text-sm">Afecta caja (entra al efvo disponible)</span></label>

        <div class="col-span-2 mt-2 pt-2 border-t border-[#fff1e6]"><p class="text-xs font-black text-[#241a0d] uppercase">Costo del medio (para la ganancia)</p></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Comisión % (1 pago)</label><input id="pm-com" type="number" step="0.01" value="${m.commission_pct || 0}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Acreditación (días)</label><input id="pm-sd" type="number" value="${m.settle_days || 0}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Costo extra 3 cuotas %</label><input id="pm-f3" type="number" step="0.01" value="${m.fin3 || 0}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Costo extra 6 cuotas %</label><input id="pm-f6" type="number" step="0.01" value="${m.fin6 || 0}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Costo extra 12 cuotas %</label><input id="pm-f12" type="number" step="0.01" value="${m.fin12 || 0}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Acreditación en cuotas (días)</label><input id="pm-sdc" type="number" value="${m.settle_days_cuotas || 0}" class="ing-input w-full mt-1" /></div>

        <label class="col-span-2 flex items-center gap-2 mt-1"><input id="pm-online" type="checkbox" ${m.kind === 'online' ? 'checked' : ''} /> <span class="text-sm">Es online (Tienda Nube u otra pasarela) — se usa para el costo de las ventas web</span></label>
        <div class="col-span-2" id="pm-tn-wrap" style="${m.kind === 'online' ? '' : 'display:none'}"><label class="text-xs font-bold text-[#7d6c5c] uppercase">Comisión plataforma online %</label><input id="pm-tn" type="number" step="0.01" value="${m.tn_platform_pct || 0}" class="ing-input w-full mt-1" /></div>
      </div>
    `,
    footerHTML: `<button class="ing-btn-secondary" data-act="cancel">Cancelar</button><button class="ing-btn-primary" data-act="ok">${isNew ? 'Crear' : 'Guardar'}</button>`,
    onOpen: (el, close) => {
      el.querySelector('#pm-online').addEventListener('change', (ev) => { el.querySelector('#pm-tn-wrap').style.display = ev.target.checked ? '' : 'none'; });
      el.querySelector('[data-act="cancel"]').addEventListener('click', () => close(false));
      el.querySelector('[data-act="ok"]').addEventListener('click', async () => {
        const name = el.querySelector('#pm-name').value.trim();
        if (!name) { toast('Nombre requerido', 'warn'); return; }
        const online = el.querySelector('#pm-online').checked;
        const updated = {
          id: isNew ? (el.querySelector('#pm-id').value.trim() || newId('pm')) : m.id,
          name, icon: el.querySelector('#pm-icon').value.trim() || 'payments',
          card_type: el.querySelector('#pm-card').value, kind: online ? 'online' : 'local',
          surcharge_pct: num('#pm-sur'), affects_cash: el.querySelector('#pm-ac').checked,
          commission_pct: num('#pm-com'), fin3: num('#pm-f3'), fin6: num('#pm-f6'), fin12: num('#pm-f12'),
          settle_days: num('#pm-sd'), settle_days_cuotas: num('#pm-sdc'),
          tn_platform_pct: online ? num('#pm-tn') : 0,
        };
        const prev = isNew ? null : methods[index];
        if (isNew) methods.push(updated); else methods[index] = updated;
        try {
          await Settings.setConfig('payment_methods', methods);
          state.openMethod = updated.id;
          toast('Guardado', 'success'); close(true);
        } catch (e) {
          if (isNew) methods.pop(); else methods[index] = prev;
          toast(e?.message || 'No se pudo guardar la forma de pago', 'error');
        }
      });
    },
  });
  renderPayments(container);
}

// ===== PROMOS (anidadas en cada forma de pago) =====
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Editor chico de promo: pertenece a una forma de pago (methodId). El descuento es
// informativo (leyenda en el POS, no cambia el total); el costo/comisión sale del medio.
async function editPromo(container, methods, promos, methodId, index) {
  const isNew = index === null;
  const p = isNew
    ? { id: '', method_id: methodId, name: '', discount_pct: 0, tope_amount: 0, installments: 1, active: true }
    : { ...promos[index] };
  const method = methods.find((x) => x.id === (p.method_id || methodId));
  await openModal({
    title: isNew ? 'Nueva promo' : 'Editar promo',
    size: 'sm',
    bodyHTML: `
      <div class="space-y-3">
        <div class="text-xs text-[#7d6c5c]">Forma de pago: <b class="text-[#241a0d]">${esc(method?.name || '—')}</b></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Nombre de la promo</label><input id="pr-name" value="${esc(p.name)}" class="ing-input w-full mt-1" placeholder="ej: DNI miércoles 15%" /></div>
        <div class="grid grid-cols-2 gap-3">
          <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Descuento %</label><input id="pr-disc" type="number" step="0.01" value="${p.discount_pct || 0}" class="ing-input w-full mt-1" /></div>
          <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Tope $ (0 = sin tope)</label><input id="pr-tope" type="number" value="${p.tope_amount || 0}" class="ing-input w-full mt-1" /></div>
        </div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Cuotas</label><input id="pr-inst" type="number" min="1" value="${p.installments || 1}" class="ing-input w-full mt-1" /></div>
        <label class="flex items-center gap-2"><input id="pr-active" type="checkbox" ${p.active !== false ? 'checked' : ''} /> <span class="text-sm">Activa</span></label>
        <p class="text-[11px] text-[#7d6c5c] bg-[#fff8f4] rounded-md p-2">El descuento es <b>informativo</b>: en el POS le avisás al cliente cuánto le descuenta el banco (capeado al tope). No cambia lo que cobrás. La comisión/costo y las cuotas salen de la forma de pago.</p>
      </div>
    `,
    footerHTML: `<button class="ing-btn-secondary" data-act="cancel">Cancelar</button><button class="ing-btn-primary" data-act="ok">${isNew ? 'Crear' : 'Guardar'}</button>`,
    onOpen: (el, close) => {
      el.querySelector('[data-act="cancel"]').addEventListener('click', () => close(false));
      el.querySelector('[data-act="ok"]').addEventListener('click', async () => {
        const name = el.querySelector('#pr-name').value.trim();
        if (!name) { toast('Nombre requerido', 'warn'); return; }
        const updated = {
          id: isNew ? newId('promo') : p.id, method_id: p.method_id || methodId, name,
          discount_pct: Number(el.querySelector('#pr-disc').value) || 0,
          tope_amount: Number(el.querySelector('#pr-tope').value) || 0,
          installments: Math.max(1, Number(el.querySelector('#pr-inst').value) || 1),
          active: el.querySelector('#pr-active').checked,
        };
        if (isNew) promos.push(updated); else promos[index] = updated;
        try { await Settings.setConfig('promos', promos); state.openMethod = updated.method_id; toast('Guardado', 'success'); close(true); }
        catch (e) { if (isNew) promos.pop(); else promos[index] = p; toast(e?.message || 'No se pudo guardar', 'error'); }
      });
    },
  });
  renderPayments(container);
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
