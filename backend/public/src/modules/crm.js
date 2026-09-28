// CRM — clientes con CRUD, búsqueda, historial de compras, señas y cumpleaños.
// MIGRADO A "TODO ONLINE": clientes viven en el backend (Postgres), la misma base
// que usa el POS. Antes este módulo usaba IndexedDB local, por eso un cliente creado
// acá NO aparecía en el POS (y viceversa).

import { getAll, del } from '../core/db.js';
import { api } from '../core/api.js';
import * as Senas from '../repos/senas.js';
import * as Settings from '../repos/settings.js';
import { activeBranchId } from '../core/auth.js';
import { money, fmtDate, fmtDateTime } from '../core/format.js';
import { openModal, confirmModal } from '../components/modal.js';
import { toast } from '../core/notifications.js';
import { exportSimple } from '../core/xlsx.js';
import { emptyRow } from '../components/empty-state.js';
import { loadFilter, saveFilter } from '../core/filter-state.js';

// Escape para incrustar texto de usuario en innerHTML (nombres, notas, email, etc.).
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const state = loadFilter('crm', {
  search: '',
  onlyBirthdayThisMonth: false,
});

export async function mount(el) { await render(el); }

async function render(el) {
  // Clientes y ventas del backend (fuente de verdad, compartida con el POS).
  const [customers, sales] = await Promise.all([
    api('/api/customers').catch(() => []),
    api('/api/sales?status=confirmed&limit=5000').catch(() => []),
  ]);
  // Clientes que quedaron guardados SOLO en esta PC (creados antes de migrar el
  // módulo al servidor). Se ofrecen para importar al backend.
  const localCustomers = (await getAll('customers').catch(() => [])) || [];
  const q = state.search.toLowerCase();
  const thisMonth = new Date().getMonth() + 1;
  const list = (customers || []).filter(c => {
    if (q && !(`${c.name}`.toLowerCase().includes(q) || (c.email || '').toLowerCase().includes(q) || (c.phone || '').includes(q) || (c.documentNumber || '').includes(q))) return false;
    if (state.onlyBirthdayThisMonth) {
      if (!c.birthday) return false;
      const m = new Date(c.birthday).getMonth() + 1;
      if (m !== thisMonth) return false;
    }
    return true;
  }).sort((a, b) => String(a.name).localeCompare(String(b.name), 'es', { sensitivity: 'base' }));

  // Estadísticas por cliente derivadas de las ventas reales del backend.
  const statsMap = {};
  for (const s of (sales || [])) {
    const cid = s.customerId;
    if (!cid) continue;
    const e = statsMap[cid] || { salesCount: 0, spent: 0, lastPurchase: null };
    e.salesCount++;
    e.spent += Number(s.total) || 0;
    const dt = s.datetime;
    if (dt && (!e.lastPurchase || String(dt) > String(e.lastPurchase))) e.lastPurchase = dt;
    statsMap[cid] = e;
  }

  el.innerHTML = `
    <div class="mb-6 flex justify-between items-start gap-4">
      <div>
        <h1 class="text-3xl font-black text-[#241a0d]">Clientes</h1>
        <p class="text-sm text-[#7d6c5c] mt-1">${(customers || []).length} clientes · ${list.length} visibles</p>
      </div>
      <div class="flex gap-2">
        <button id="cr-sena" class="ing-btn-secondary flex items-center gap-2"><span class="material-symbols-outlined text-base">savings</span> Nueva seña</button>
        <button id="cr-new" class="ing-btn-primary flex items-center gap-2"><span class="material-symbols-outlined text-base">add</span> Nuevo cliente</button>
        <button id="cr-export" class="ing-btn-secondary flex items-center gap-2"><span class="material-symbols-outlined text-base">download</span> XLSX</button>
      </div>
    </div>

    ${localCustomers.length ? `
    <div class="ing-card p-3 mb-4 border-l-4 border-amber-500 bg-amber-50 flex items-center justify-between gap-3 flex-wrap">
      <div class="text-sm text-[#241a0d]"><b>${localCustomers.length} cliente(s)</b> quedaron guardados solo en esta PC (creados antes de la actualización). Importalos al servidor para que aparezcan en el POS y en las demás PC.</div>
      <button id="cr-migrate" class="ing-btn-primary !py-1.5 !px-3 text-sm shrink-0">Importar ${localCustomers.length} al servidor</button>
    </div>` : ''}

    <div class="ing-card p-3 mb-4 flex gap-3 items-center">
      <input id="cr-q" placeholder="Buscar por nombre, email, teléfono o documento…" value="${esc(state.search)}" class="ing-input flex-1" />
      <label class="flex items-center gap-2 text-sm cursor-pointer"><input type="checkbox" id="cr-bd" ${state.onlyBirthdayThisMonth?'checked':''} /> Cumpleaños este mes</label>
    </div>

    <div class="ing-card overflow-hidden">
      <table class="ing-table w-full">
        <thead>
          <tr>
            <th>Nombre</th><th>Documento</th><th>Contacto</th><th>Cumpleaños</th>
            <th class="text-right">Compras</th><th class="text-right">Gastado</th>
            <th>Última compra</th><th></th>
          </tr>
        </thead>
        <tbody>
          ${list.length ? list.map(c => {
            const s = statsMap[c.id] || {};
            return `
              <tr>
                <td class="font-bold">${esc(c.name)}</td>
                <td class="text-xs">${c.documentNumber ? esc((c.documentType || 'Doc') + ' ' + c.documentNumber) : '—'}</td>
                <td class="text-xs">${esc(c.email || '—')}${c.phone ? `<br>${esc(c.phone)}`:''}</td>
                <td class="text-xs">${c.birthday ? fmtDate(c.birthday) : '—'}</td>
                <td class="text-right">${s.salesCount || 0}</td>
                <td class="text-right font-bold">${money(s.spent || 0)}</td>
                <td class="text-xs">${s.lastPurchase ? fmtDate(s.lastPurchase) : '—'}</td>
                <td class="text-right">
                  <button data-view="${c.id}" class="text-xs text-[#d82f1e] hover:underline">Ver</button>
                  <button data-edit="${c.id}" class="text-xs text-[#d82f1e] hover:underline ml-1">Editar</button>
                  <button data-del="${c.id}" class="text-xs text-[#7d6c5c] hover:text-red-600 ml-1">Borrar</button>
                </td>
              </tr>
            `;
          }).join('') : emptyRow(8, { icon: 'group_add', title: state.search ? 'Sin resultados' : 'Sin clientes', hint: state.search ? 'Probá con otro término de búsqueda.' : 'Cargá al primer cliente para llevar historial, señas y cumpleaños.', ctaLabel: state.search ? '' : 'Nuevo cliente', ctaAttr: 'data-empty-new="cust"' })}
        </tbody>
      </table>
    </div>
  `;

  el.querySelector('#cr-q').addEventListener('input', (ev) => { state.search = ev.target.value; saveFilter('crm', state); render(el); });
  el.querySelector('#cr-bd').addEventListener('change', (ev) => { state.onlyBirthdayThisMonth = ev.target.checked; saveFilter('crm', state); render(el); });
  el.querySelector('#cr-new').addEventListener('click', () => editCustomer(el, null));
  el.querySelector('#cr-sena').addEventListener('click', () => newSena(el));
  el.querySelector('#cr-migrate')?.addEventListener('click', (ev) => migrateLocalCustomers(el, localCustomers, ev.currentTarget));
  el.querySelector('[data-empty-new="cust"]')?.addEventListener('click', () => editCustomer(el, null));
  el.querySelector('#cr-export').addEventListener('click', () => {
    exportSimple(`clientes.xlsx`, list.map(c => ({
      Nombre: c.name, TipoDoc: c.documentType || '', Documento: c.documentNumber || '',
      Email: c.email || '', Telefono: c.phone || '',
      Cumpleanos: c.birthday ? fmtDate(c.birthday) : '', Direccion: c.address || '',
      Compras: statsMap[c.id]?.salesCount || 0, Gastado: statsMap[c.id]?.spent || 0,
    })), 'Clientes');
  });
  el.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => { const c = (customers || []).find(x => x.id === b.dataset.view); if (c) viewCustomer(el, c); }));
  el.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => { const c = (customers || []).find(x => x.id === b.dataset.edit); if (c) editCustomer(el, c); }));
  el.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    const ok = await confirmModal({ title: 'Borrar', message: '¿Eliminar cliente?', danger: true, confirmLabel: 'Borrar' });
    if (!ok) return;
    try {
      await api(`/api/customers/${encodeURIComponent(b.dataset.del)}`, { method: 'DELETE' });
      toast('Cliente eliminado', 'success'); render(el);
    } catch (e) {
      toast(e?.message || 'No se pudo eliminar', 'error');
    }
  }));
}

// Sube al backend los clientes que quedaron solo en esta PC (IndexedDB), creados
// antes de migrar el módulo. Idempotente: si el documento ya existe en el servidor
// lo cuenta como "ya estaba" y borra la copia local igual.
async function migrateLocalCustomers(root, localCustomers, btn) {
  if (btn) { if (btn.disabled) return; btn.disabled = true; btn.textContent = 'Importando…'; }
  let imported = 0, skipped = 0, failed = 0;
  for (const c of localCustomers) {
    const name = `${c.name || ''} ${c.lastname || ''}`.trim();
    if (!name) { // sin nombre no se puede: descartamos la copia local
      try { await del('customers', c.id); } catch { /* noop */ }
      skipped++; continue;
    }
    const body = {
      name,
      documentType: c.documentType || 'DNI',
      documentNumber: (c.document || c.documentNumber || '').toString().trim() || null,
      email: c.email || null,
      phone: c.phone || null,
      address: c.address || null,
      birthday: c.birthday || null,
      notes: c.note || c.notes || null,
    };
    try {
      await api('/api/customers', { method: 'POST', body });
      imported++;
      try { await del('customers', c.id); } catch { /* noop */ }
    } catch (e) {
      // Documento duplicado = ya está en el servidor → limpiamos la copia local.
      if (/ya existe/i.test(e?.message || '')) {
        skipped++;
        try { await del('customers', c.id); } catch { /* noop */ }
      } else {
        failed++;
      }
    }
  }
  toast(`Importados: ${imported} · ya estaban: ${skipped}${failed ? ` · con error: ${failed}` : ''}`, failed ? 'warn' : 'success');
  render(root);
}

async function editCustomer(root, existing) {
  const isNew = !existing;
  const c = existing || { name: '', email: '', phone: '', address: '', birthday: '', notes: '', documentType: 'DNI', documentNumber: '' };
  const bd = c.birthday ? String(c.birthday).slice(0, 10) : '';
  const dtypes = ['DNI', 'CUIT', 'CUIL', 'Pasaporte'];
  await openModal({
    title: isNew ? 'Nuevo cliente' : 'Editar cliente',
    size: 'md',
    bodyHTML: `
      <div class="grid grid-cols-2 gap-3">
        <div class="col-span-2"><label class="text-xs font-bold text-[#7d6c5c] uppercase">Nombre y apellido *</label><input id="cu-name" value="${esc(c.name)}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Tipo doc.</label>
          <select id="cu-dtype" class="ing-input w-full mt-1">${dtypes.map(t => `<option ${(c.documentType||'DNI')===t?'selected':''}>${t}</option>`).join('')}</select></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Documento</label><input id="cu-doc" value="${esc(c.documentNumber)}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Email</label><input id="cu-email" type="email" value="${esc(c.email)}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Teléfono</label><input id="cu-phone" value="${esc(c.phone)}" class="ing-input w-full mt-1" /></div>
        <div class="col-span-2"><label class="text-xs font-bold text-[#7d6c5c] uppercase">Dirección</label><input id="cu-addr" value="${esc(c.address)}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Cumpleaños</label><input id="cu-bd" type="date" value="${bd}" class="ing-input w-full mt-1" /></div>
        <div class="col-span-2"><label class="text-xs font-bold text-[#7d6c5c] uppercase">Nota</label><textarea id="cu-note" class="ing-input w-full mt-1" rows="2">${esc(c.notes)}</textarea></div>
      </div>
    `,
    footerHTML: `<button class="ing-btn-secondary" data-act="cancel">Cancelar</button><button class="ing-btn-primary" data-act="ok">${isNew?'Crear':'Guardar'}</button>`,
    onOpen: (m, close) => {
      m.querySelector('[data-act="cancel"]').addEventListener('click', () => close(false));
      const okBtn = m.querySelector('[data-act="ok"]');
      okBtn.addEventListener('click', async () => {
        const name = m.querySelector('#cu-name').value.trim();
        if (!name) { toast('Nombre requerido', 'warn'); return; }
        const body = {
          name,
          documentType: m.querySelector('#cu-dtype').value,
          documentNumber: m.querySelector('#cu-doc').value.trim() || null,
          email: m.querySelector('#cu-email').value.trim() || null,
          phone: m.querySelector('#cu-phone').value.trim() || null,
          address: m.querySelector('#cu-addr').value.trim() || null,
          birthday: m.querySelector('#cu-bd').value || null,
          notes: m.querySelector('#cu-note').value.trim() || null,
        };
        if (okBtn.disabled) return;
        okBtn.disabled = true;
        try {
          if (isNew) await api('/api/customers', { method: 'POST', body });
          else await api(`/api/customers/${encodeURIComponent(c.id)}`, { method: 'PUT', body });
          toast(isNew ? 'Cliente creado' : 'Actualizado', 'success');
          close(true);
          render(root);
        } catch (e) {
          toast(e?.message || 'No se pudo guardar', 'error');
          okBtn.disabled = false;
        }
      });
    },
  });
}

async function viewCustomer(root, c) {
  // Historial real desde el backend.
  const mySales = (await api(`/api/customers/${encodeURIComponent(c.id)}/sales`).catch(() => [])) || [];
  const spent = mySales.reduce((s, x) => s + (Number(x.total) || 0), 0);
  const avgTicket = mySales.length ? spent / mySales.length : 0;
  const lastPurchase = mySales[0]?.datetime;
  const daysSinceLast = lastPurchase ? Math.floor((Date.now() - new Date(lastPurchase).getTime()) / 86400000) : null;

  // Top productos comprados (a partir de los items de las ventas).
  const byProduct = {};
  for (const s of mySales) {
    for (const it of (s.items || [])) {
      const k = it.productNameSnap || it.variantId || 'Producto';
      if (!byProduct[k]) byProduct[k] = { qty: 0, spent: 0 };
      byProduct[k].qty += Number(it.qty) || 0;
      byProduct[k].spent += Number(it.subtotal) || 0;
    }
  }
  const topProducts = Object.entries(byProduct).sort((a, b) => b[1].qty - a[1].qty).slice(0, 5);

  await openModal({
    title: `${c.name}`,
    size: 'lg',
    bodyHTML: `
      <div class="grid grid-cols-4 gap-3 mb-4">
        <div class="ing-card p-3"><div class="text-[10px] font-black uppercase text-[#7d6c5c]">Compras</div><div class="text-2xl font-black">${mySales.length}</div></div>
        <div class="ing-card p-3"><div class="text-[10px] font-black uppercase text-[#7d6c5c]">Gastado total</div><div class="text-2xl font-black text-[#d82f1e]">${money(spent)}</div></div>
        <div class="ing-card p-3"><div class="text-[10px] font-black uppercase text-[#7d6c5c]">Ticket promedio</div><div class="text-2xl font-black">${money(avgTicket)}</div></div>
        <div class="ing-card p-3"><div class="text-[10px] font-black uppercase text-[#7d6c5c]">Última compra</div><div class="text-lg font-black">${lastPurchase ? fmtDate(lastPurchase) : '—'}</div><div class="text-[10px] text-[#7d6c5c]">${daysSinceLast != null ? `hace ${daysSinceLast} d` : ''}</div></div>
      </div>
      <div class="space-y-2 text-sm mb-4">
        ${c.documentNumber ? `<div><strong>${esc(c.documentType || 'Doc')}:</strong> ${esc(c.documentNumber)}</div>` : ''}
        ${c.email ? `<div><strong>Email:</strong> ${esc(c.email)}</div>` : ''}
        ${c.phone ? `<div><strong>Tel:</strong> ${esc(c.phone)}</div>` : ''}
        ${c.address ? `<div><strong>Dir:</strong> ${esc(c.address)}</div>` : ''}
        ${c.birthday ? `<div><strong>Cumpleaños:</strong> ${fmtDate(c.birthday)}</div>` : ''}
        ${c.notes ? `<div class="p-2 bg-[#fff8f4] rounded">${esc(c.notes)}</div>` : ''}
      </div>
      ${topProducts.length ? `
        <h4 class="font-black mt-4 mb-2">Top productos</h4>
        <div class="border border-[#fff1e6] rounded-xl overflow-hidden mb-4">
          ${topProducts.map(([name, v]) => `
            <div class="flex justify-between items-center px-3 py-2 border-b border-[#fff1e6] last:border-0">
              <div class="break-words leading-tight flex-1">${esc(name)}</div>
              <div class="flex gap-4 shrink-0">
                <span class="text-xs text-[#7d6c5c]">${v.qty} u.</span>
                <span class="font-bold">${money(v.spent)}</span>
              </div>
            </div>
          `).join('')}
        </div>
      ` : ''}
      <h4 class="font-black mt-4 mb-2">Historial de compras</h4>
      <div class="border border-[#fff1e6] rounded-xl overflow-hidden max-h-48 overflow-y-auto">
        ${mySales.length ? mySales.map(s => `
          <div class="flex justify-between px-3 py-2 border-b border-[#fff1e6] last:border-0">
            <div><span class="font-mono font-bold">#${s.number}</span> · <span class="text-xs text-[#7d6c5c]">${fmtDateTime(s.datetime)}</span> <span class="text-[10px] text-[#7d6c5c]">· ${(s.items||[]).length} items</span></div>
            <div class="font-bold">${money(s.total)}</div>
          </div>
        `).join('') : '<div class="p-3 text-center text-[#7d6c5c] text-sm">Sin compras</div>'}
      </div>
    `,
    footerHTML: `<button class="ing-btn-primary" data-act="close">Cerrar</button>`,
    onOpen: (m, close) => { m.querySelector('[data-act="close"]').addEventListener('click', () => close(true)); },
  });
}

// ===== Nueva seña (reserva con anticipo) =====
async function newSena(el) {
  const methodsCfg = (await Settings.getConfig('payment_methods', [])) || [];
  const methods = methodsCfg.length ? methodsCfg : [
    { id: 'cash', name: 'Efectivo', affects_cash: true },
    { id: 'transfer', name: 'Transferencia', affects_cash: false },
    { id: 'card', name: 'Tarjeta', affects_cash: false },
  ];
  let customer = null;
  await openModal({
    title: 'Nueva seña',
    size: 'sm',
    bodyHTML: `
      <label class="block text-xs font-bold text-[#7d6c5c] uppercase mb-1">Cliente (por documento)</label>
      <div class="flex gap-2">
        <input id="sena-doc" class="ing-input flex-1" placeholder="N° de documento…" inputmode="numeric" />
        <button id="sena-find" type="button" class="ing-btn-secondary !px-3">Buscar</button>
      </div>
      <div id="sena-cust-info" class="text-xs text-[#7d6c5c] mt-1">Buscá el cliente o, si no existe, se crea al buscar.</div>
      <label class="block text-xs font-bold text-[#7d6c5c] uppercase mb-1 mt-3">Monto de la seña *</label>
      <input id="sena-amt" type="number" step="0.01" min="0" class="ing-input w-full" placeholder="0" />
      <label class="block text-xs font-bold text-[#7d6c5c] uppercase mb-1 mt-3">Medio de pago</label>
      <select id="sena-method" class="ing-input w-full">${methods.map(m => `<option value="${m.id}" data-cash="${m.affects_cash ? 1 : 0}">${esc(m.name)}</option>`).join('')}</select>
      <div class="text-[11px] text-[#7d6c5c] mt-1">Si es en efectivo, la seña entra a la caja al crearla.</div>
      <label class="block text-xs font-bold text-[#7d6c5c] uppercase mb-1 mt-3">Producto / nota</label>
      <input id="sena-note" class="ing-input w-full" placeholder="Qué reserva (opcional)" />
    `,
    footerHTML: `<button class="ing-btn-secondary" data-act="cancel">Cancelar</button><button class="ing-btn-primary" data-act="ok">Crear seña</button>`,
    onOpen: (m, close) => {
      const info = m.querySelector('#sena-cust-info');
      const setCustomer = (c) => { customer = c; info.textContent = c ? `Cliente: ${c.name}${c.documentNumber ? ' · Doc ' + c.documentNumber : ''}` : 'Buscá el cliente.'; };
      const doFind = async () => {
        const v = (m.querySelector('#sena-doc').value || '').trim();
        if (!v) { toast('Ingresá un documento', 'warn'); return; }
        try {
          const found = await api(`/api/customers/by-document/${encodeURIComponent(v)}`);
          if (found) { setCustomer(found); toast(`Cliente: ${found.name}`, 'success'); return; }
          const name = window.prompt('Cliente nuevo — nombre y apellido:');
          if (!name) return;
          const created = await api('/api/customers', { method: 'POST', body: { name, documentNumber: v, documentType: 'DNI' } });
          setCustomer(created); toast('Cliente creado', 'success');
        } catch (e) { toast('Error: ' + (e.message || ''), 'error'); }
      };
      m.querySelector('#sena-find').addEventListener('click', doFind);
      m.querySelector('#sena-doc').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); doFind(); } });
      m.querySelector('[data-act="cancel"]').addEventListener('click', () => close(false));
      m.querySelector('[data-act="ok"]').addEventListener('click', async () => {
        if (!customer) { toast('Elegí (o creá) un cliente por documento', 'warn'); return; }
        const amount = Number(m.querySelector('#sena-amt').value) || 0;
        if (amount <= 0) { toast('El monto debe ser mayor a 0', 'warn'); return; }
        const sel = m.querySelector('#sena-method');
        const opt = sel.options[sel.selectedIndex];
        const note = m.querySelector('#sena-note').value.trim() || null;
        try {
          const sena = await Senas.create({
            customerId: customer.id, amount, branchId: activeBranchId(),
            methodId: sel.value, methodName: opt.text, affectsCash: opt.dataset.cash === '1', note,
          });
          close(true);
          toast(`Seña #${sena.number} creada (${money(amount)})${opt.dataset.cash === '1' ? ' · entró a caja' : ''}`, 'success');
          render(el);
        } catch (e) { toast('No se pudo crear: ' + (e.message || ''), 'error'); }
      });
    },
  });
}
