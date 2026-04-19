// CRM — clientes con CRUD, búsqueda, historial de compras, vales y cumpleaños.

import { getAll, put, del, newId } from '../core/db.js';
import { money, fmtDate, fmtDateTime } from '../core/format.js';
import { openModal, confirmModal } from '../components/modal.js';
import { toast } from '../core/notifications.js';
import * as Audit from '../core/audit.js';
import { exportSimple } from '../core/xlsx.js';
import { emptyRow } from '../components/empty-state.js';
import { loadFilter, saveFilter } from '../core/filter-state.js';

const state = loadFilter('crm', {
  search: '',
  onlyBirthdayThisMonth: false,
});

export async function mount(el) { await render(el); }

async function render(el) {
  const [customers, sales, creditNotes] = await Promise.all([getAll('customers'), getAll('sales'), getAll('credit_notes')]);
  const q = state.search.toLowerCase();
  const thisMonth = new Date().getMonth() + 1;
  const list = customers.filter(c => {
    if (q && !(`${c.name} ${c.lastname || ''}`.toLowerCase().includes(q) || (c.email || '').toLowerCase().includes(q) || (c.phone || '').includes(q))) return false;
    if (state.onlyBirthdayThisMonth) {
      if (!c.birthday) return false;
      const m = new Date(c.birthday).getMonth() + 1;
      if (m !== thisMonth) return false;
    }
    return true;
  }).sort((a, b) => (a.name + a.lastname).localeCompare(b.name + b.lastname));

  const stats = customers.map(c => {
    const mySales = sales.filter(s => s.customer_id === c.id);
    const myVales = creditNotes.filter(v => v.customer_id === c.id && !v.redeemed_at);
    const spent = mySales.reduce((s, x) => s + (x.total || 0), 0);
    const valesAmt = myVales.reduce((s, v) => s + (Number(v.amount) || 0), 0);
    return { id: c.id, salesCount: mySales.length, spent, valesAmt, lastPurchase: mySales.sort((a,b) => b.datetime.localeCompare(a.datetime))[0]?.datetime };
  });
  const statsMap = Object.fromEntries(stats.map(s => [s.id, s]));

  el.innerHTML = `
    <div class="mb-6 flex justify-between items-start gap-4">
      <div>
        <h1 class="text-3xl font-black text-[#241a0d]">Clientes</h1>
        <p class="text-sm text-[#7d6c5c] mt-1">${customers.length} clientes · ${list.length} visibles</p>
      </div>
      <div class="flex gap-2">
        <button id="cr-new" class="ing-btn-primary flex items-center gap-2"><span class="material-symbols-outlined text-base">add</span> Nuevo cliente</button>
        <button id="cr-export" class="ing-btn-secondary flex items-center gap-2"><span class="material-symbols-outlined text-base">download</span> XLSX</button>
      </div>
    </div>

    <div class="ing-card p-3 mb-4 flex gap-3 items-center">
      <input id="cr-q" placeholder="Buscar por nombre, email o teléfono…" value="${state.search}" class="ing-input flex-1" />
      <label class="flex items-center gap-2 text-sm cursor-pointer"><input type="checkbox" id="cr-bd" ${state.onlyBirthdayThisMonth?'checked':''} /> Cumpleaños este mes</label>
    </div>

    <div class="ing-card overflow-hidden">
      <table class="ing-table w-full">
        <thead>
          <tr>
            <th>Nombre</th><th>Contacto</th><th>Cumpleaños</th>
            <th class="text-right">Compras</th><th class="text-right">Gastado</th><th class="text-right">Vales</th>
            <th>Última compra</th><th></th>
          </tr>
        </thead>
        <tbody>
          ${list.length ? list.map(c => {
            const s = statsMap[c.id] || {};
            return `
              <tr>
                <td class="font-bold">${c.name} ${c.lastname || ''}</td>
                <td class="text-xs">${c.email || '—'}${c.phone ? `<br>${c.phone}`:''}</td>
                <td class="text-xs">${c.birthday ? fmtDate(c.birthday) : '—'}</td>
                <td class="text-right">${s.salesCount || 0}</td>
                <td class="text-right font-bold">${money(s.spent || 0)}</td>
                <td class="text-right ${s.valesAmt ? 'text-[#d82f1e] font-bold' : 'text-[#7d6c5c]'}">${money(s.valesAmt || 0)}</td>
                <td class="text-xs">${s.lastPurchase ? fmtDate(s.lastPurchase) : '—'}</td>
                <td class="text-right">
                  <button data-view="${c.id}" class="text-xs text-[#d82f1e] hover:underline">Ver</button>
                  <button data-edit="${c.id}" class="text-xs text-[#d82f1e] hover:underline ml-1">Editar</button>
                  <button data-del="${c.id}" class="text-xs text-[#7d6c5c] hover:text-red-600 ml-1">Borrar</button>
                </td>
              </tr>
            `;
          }).join('') : emptyRow(8, { icon: 'group_add', title: state.search ? 'Sin resultados' : 'Sin clientes', hint: state.search ? 'Probá con otro término de búsqueda.' : 'Cargá al primer cliente para llevar historial, vales y cumpleaños.', ctaLabel: state.search ? '' : 'Nuevo cliente', ctaAttr: 'data-empty-new="cust"' })}
        </tbody>
      </table>
    </div>
  `;

  el.querySelector('#cr-q').addEventListener('input', (ev) => { state.search = ev.target.value; saveFilter('crm', state); render(el); });
  el.querySelector('#cr-bd').addEventListener('change', (ev) => { state.onlyBirthdayThisMonth = ev.target.checked; saveFilter('crm', state); render(el); });
  el.querySelector('#cr-new').addEventListener('click', () => editCustomer(el, null));
  el.querySelector('[data-empty-new="cust"]')?.addEventListener('click', () => editCustomer(el, null));
  el.querySelector('#cr-export').addEventListener('click', () => {
    exportSimple(`clientes.xlsx`, list.map(c => ({
      Nombre: c.name, Apellido: c.lastname || '', Email: c.email || '', Telefono: c.phone || '',
      Cumpleanos: c.birthday || '', Direccion: c.address || '',
      Compras: statsMap[c.id]?.salesCount || 0, Gastado: statsMap[c.id]?.spent || 0,
    })), 'Clientes');
  });
  el.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => { const c = customers.find(x => x.id === b.dataset.view); if (c) viewCustomer(el, c, sales, creditNotes); }));
  el.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => { const c = customers.find(x => x.id === b.dataset.edit); if (c) editCustomer(el, c); }));
  el.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    const ok = await confirmModal({ title: 'Borrar', message: '¿Eliminar cliente?', danger: true, confirmLabel: 'Borrar' });
    if (!ok) return;
    await del('customers', b.dataset.del);
    await Audit.log({ action: 'delete', entity: 'cliente', entity_id: b.dataset.del, description: 'Cliente eliminado' });
    toast('Cliente eliminado', 'success'); render(el);
  }));
}

async function editCustomer(root, existing) {
  const isNew = !existing;
  const c = existing || { id: newId('cus'), name: '', lastname: '', email: '', phone: '', address: '', birthday: '', note: '' };
  await openModal({
    title: isNew ? 'Nuevo cliente' : 'Editar cliente',
    size: 'md',
    bodyHTML: `
      <div class="grid grid-cols-2 gap-3">
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Nombre *</label><input id="cu-name" value="${c.name||''}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Apellido</label><input id="cu-last" value="${c.lastname||''}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Email</label><input id="cu-email" type="email" value="${c.email||''}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Teléfono</label><input id="cu-phone" value="${c.phone||''}" class="ing-input w-full mt-1" /></div>
        <div class="col-span-2"><label class="text-xs font-bold text-[#7d6c5c] uppercase">Dirección</label><input id="cu-addr" value="${c.address||''}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Cumpleaños</label><input id="cu-bd" type="date" value="${c.birthday||''}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Documento / CUIT</label><input id="cu-doc" value="${c.document||''}" class="ing-input w-full mt-1" /></div>
        <div class="col-span-2"><label class="text-xs font-bold text-[#7d6c5c] uppercase">Nota</label><textarea id="cu-note" class="ing-input w-full mt-1" rows="2">${c.note||''}</textarea></div>
      </div>
    `,
    footerHTML: `<button class="ing-btn-secondary" data-act="cancel">Cancelar</button><button class="ing-btn-primary" data-act="ok">${isNew?'Crear':'Guardar'}</button>`,
    onOpen: (m, close) => {
      m.querySelector('[data-act="cancel"]').addEventListener('click', () => close(false));
      m.querySelector('[data-act="ok"]').addEventListener('click', async () => {
        c.name = m.querySelector('#cu-name').value.trim();
        if (!c.name) { toast('Nombre requerido', 'warn'); return; }
        c.lastname = m.querySelector('#cu-last').value.trim();
        c.email = m.querySelector('#cu-email').value.trim();
        c.phone = m.querySelector('#cu-phone').value.trim();
        c.address = m.querySelector('#cu-addr').value.trim();
        c.birthday = m.querySelector('#cu-bd').value;
        c.document = m.querySelector('#cu-doc').value.trim();
        c.note = m.querySelector('#cu-note').value;
        if (isNew) c.created_at = new Date().toISOString();
        await put('customers', c);
        await Audit.log({ action: isNew?'create':'update', entity: 'cliente', entity_id: c.id, after: c, description: `${c.name} ${c.lastname||''}` });
        toast(isNew?'Cliente creado':'Actualizado', 'success'); close(true);
      });
    },
  });
  render(root);
}

async function viewCustomer(root, c, sales, creditNotes) {
  const mySales = sales.filter(s => s.customer_id === c.id).sort((a,b) => b.datetime.localeCompare(a.datetime));
  const myVales = creditNotes.filter(v => v.customer_id === c.id);
  const spent = mySales.reduce((s, x) => s + (x.total || 0), 0);
  const avgTicket = mySales.length ? spent / mySales.length : 0;
  const lastPurchase = mySales[0]?.datetime;
  const daysSinceLast = lastPurchase ? Math.floor((Date.now() - new Date(lastPurchase).getTime()) / 86400000) : null;
  const valesActivos = myVales.filter(v => !v.redeemed_at);
  const creditoDisponible = valesActivos.reduce((s, v) => s + (Number(v.amount) || 0), 0);

  // Top productos comprados (U-4)
  const byProduct = {};
  for (const s of mySales) {
    for (const it of (s.items || [])) {
      const k = it.name || it.product_id;
      if (!byProduct[k]) byProduct[k] = { qty: 0, spent: 0 };
      byProduct[k].qty += Number(it.qty) || 0;
      byProduct[k].spent += Number(it.subtotal) || 0;
    }
  }
  const topProducts = Object.entries(byProduct).sort((a, b) => b[1].qty - a[1].qty).slice(0, 5);

  await openModal({
    title: `${c.name} ${c.lastname || ''}`,
    size: 'lg',
    bodyHTML: `
      <div class="grid grid-cols-4 gap-3 mb-4">
        <div class="ing-card p-3"><div class="text-[10px] font-black uppercase text-[#7d6c5c]">Compras</div><div class="text-2xl font-black">${mySales.length}</div></div>
        <div class="ing-card p-3"><div class="text-[10px] font-black uppercase text-[#7d6c5c]">Gastado total</div><div class="text-2xl font-black text-[#d82f1e]">${money(spent)}</div></div>
        <div class="ing-card p-3"><div class="text-[10px] font-black uppercase text-[#7d6c5c]">Ticket promedio</div><div class="text-2xl font-black">${money(avgTicket)}</div></div>
        <div class="ing-card p-3"><div class="text-[10px] font-black uppercase text-[#7d6c5c]">Última compra</div><div class="text-lg font-black">${lastPurchase ? fmtDate(lastPurchase) : '—'}</div><div class="text-[10px] text-[#7d6c5c]">${daysSinceLast != null ? `hace ${daysSinceLast} d` : ''}</div></div>
      </div>
      <div class="grid grid-cols-2 gap-3 mb-4">
        <div class="ing-card p-3"><div class="text-[10px] font-black uppercase text-[#7d6c5c]">Vales activos</div><div class="text-xl font-black text-green-700">${valesActivos.length}</div></div>
        <div class="ing-card p-3"><div class="text-[10px] font-black uppercase text-[#7d6c5c]">Crédito disponible</div><div class="text-xl font-black text-green-700">${money(creditoDisponible)}</div></div>
      </div>
      <div class="space-y-2 text-sm mb-4">
        ${c.email ? `<div><strong>Email:</strong> ${c.email}</div>` : ''}
        ${c.phone ? `<div><strong>Tel:</strong> ${c.phone}</div>` : ''}
        ${c.address ? `<div><strong>Dir:</strong> ${c.address}</div>` : ''}
        ${c.document ? `<div><strong>Doc:</strong> ${c.document}</div>` : ''}
        ${c.birthday ? `<div><strong>Cumpleaños:</strong> ${fmtDate(c.birthday)}</div>` : ''}
        ${c.note ? `<div class="p-2 bg-[#fff8f4] rounded">${c.note}</div>` : ''}
      </div>
      ${topProducts.length ? `
        <h4 class="font-black mt-4 mb-2">Top productos</h4>
        <div class="border border-[#fff1e6] rounded-xl overflow-hidden mb-4">
          ${topProducts.map(([name, v]) => `
            <div class="flex justify-between items-center px-3 py-2 border-b border-[#fff1e6] last:border-0">
              <div class="truncate flex-1">${name}</div>
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
      ${myVales.length ? `
        <h4 class="font-black mt-4 mb-2">Vales</h4>
        <div class="border border-[#fff1e6] rounded-xl overflow-hidden">
          ${myVales.map(v => `
            <div class="flex justify-between items-center px-3 py-2 border-b border-[#fff1e6] last:border-0">
              <div><span class="font-mono font-bold text-[#d82f1e]">${v.code}</span></div>
              <div><span class="font-bold">${money(v.amount)}</span> <span class="text-xs ${v.redeemed_at?'text-[#7d6c5c]':'text-green-700'}">${v.redeemed_at?'Canjeado':'Activo'}</span></div>
            </div>
          `).join('')}
        </div>
      ` : ''}
    `,
    footerHTML: `<button class="ing-btn-primary" data-act="close">Cerrar</button>`,
    onOpen: (m, close) => { m.querySelector('[data-act="close"]').addEventListener('click', () => close(true)); },
  });
}
