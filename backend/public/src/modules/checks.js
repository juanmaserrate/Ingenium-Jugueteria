// Cheques — a proveedores con plazos, notificaciones de vencimiento y suma pendiente.

import { getAll, put, newId, del } from '../core/db.js';
import { money, fmtDate } from '../core/format.js';
import { activeBranchId, currentSession } from '../core/auth.js';
import { openModal, confirmModal } from '../components/modal.js';
import { toast, push } from '../core/notifications.js';
import * as Audit from '../core/audit.js';
import { exportSimple } from '../core/xlsx.js';
import * as Cash from '../repos/cash.js';
import { emptyRow } from '../components/empty-state.js';

const state = {
  tab: 'all', // all | pending | paid | bounced | overdue | soon
};

export async function mount(el) { await render(el); checkUpcoming(); }

async function render(el) {
  const branchId = activeBranchId();
  const [checks, suppliers] = await Promise.all([getAll('checks'), getAll('suppliers')]);
  const supMap = Object.fromEntries(suppliers.map(s => [s.id, s.name]));
  const today = new Date().toISOString().slice(0, 10);
  const in7 = new Date(); in7.setDate(in7.getDate() + 7); const in7k = in7.toISOString().slice(0, 10);

  const filtered = checks.filter(c => c.branch_id === branchId).filter(c => {
    if (state.tab === 'pending') return c.status === 'pending';
    if (state.tab === 'paid') return c.status === 'paid';
    if (state.tab === 'bounced') return c.status === 'bounced';
    if (state.tab === 'overdue') return c.status === 'pending' && c.due_at < today;
    if (state.tab === 'soon') return c.status === 'pending' && c.due_at >= today && c.due_at <= in7k;
    return true;
  }).sort((a, b) => (a.due_at || '').localeCompare(b.due_at || ''));

  const pendingSum = checks.filter(c => c.branch_id === branchId && c.status === 'pending').reduce((s, c) => s + (Number(c.amount) || 0), 0);
  const overdueCount = checks.filter(c => c.branch_id === branchId && c.status === 'pending' && c.due_at < today).length;
  const soonCount = checks.filter(c => c.branch_id === branchId && c.status === 'pending' && c.due_at >= today && c.due_at <= in7k).length;

  el.innerHTML = `
    <div class="mb-6 flex justify-between items-start gap-4">
      <div>
        <h1 class="text-3xl font-black text-[#241a0d]">Cheques</h1>
        <p class="text-sm text-[#7d6c5c] mt-1">Emitidos a proveedores con vencimiento y alertas</p>
      </div>
      <div class="flex gap-2">
        <button id="ch-new" class="ing-btn-primary flex items-center gap-2"><span class="material-symbols-outlined text-base">add</span> Nuevo cheque</button>
        <button id="ch-export" class="ing-btn-secondary flex items-center gap-2"><span class="material-symbols-outlined text-base">download</span> XLSX</button>
      </div>
    </div>

    <div class="grid grid-cols-3 gap-3 mb-4">
      <div class="ing-card p-4"><div class="text-[10px] font-black uppercase text-[#7d6c5c]">Pendiente total</div><div class="text-2xl font-black text-[#d82f1e]">${money(pendingSum)}</div></div>
      <div class="ing-card p-4"><div class="text-[10px] font-black uppercase text-[#7d6c5c]">Vencidos</div><div class="text-2xl font-black text-red-600">${overdueCount}</div></div>
      <div class="ing-card p-4"><div class="text-[10px] font-black uppercase text-[#7d6c5c]">Próximos 7 días</div><div class="text-2xl font-black text-orange-600">${soonCount}</div></div>
    </div>

    <div class="flex gap-2 mb-4 border-b border-[#fff1e6]">
      ${tabBtn('all','Todos','list')}
      ${tabBtn('pending','Pendientes','pending')}
      ${tabBtn('overdue','Vencidos','warning')}
      ${tabBtn('soon','Próximos','schedule')}
      ${tabBtn('paid','Pagados','check_circle')}
      ${tabBtn('bounced','Rebotados','error')}
    </div>

    <div class="ing-card overflow-hidden">
      <table class="ing-table w-full">
        <thead>
          <tr><th>Número</th><th>Proveedor</th><th>Banco</th><th>Emisión</th><th>Vence</th><th class="text-right">Monto</th><th>Estado</th><th></th></tr>
        </thead>
        <tbody>
          ${filtered.length ? filtered.map(c => {
            const expired = c.status === 'pending' && c.due_at < today;
            const badge = c.status === 'paid' ? { t:'Pagado', c: 'bg-green-100 text-green-700' }
                        : c.status === 'bounced' ? { t: 'Rebotado', c: 'bg-red-100 text-red-700' }
                        : expired ? { t: 'VENCIDO', c: 'bg-red-600 text-white' }
                        : { t: 'Pendiente', c: 'bg-orange-100 text-orange-700' };
            return `
              <tr class="${expired ? 'bg-red-50' : ''}">
                <td class="font-mono font-bold">${c.number}</td>
                <td>${supMap[c.supplier_id] || '—'}</td>
                <td>${c.bank || '—'}</td>
                <td class="text-xs">${fmtDate(c.issued_at)}</td>
                <td class="text-xs ${expired ? 'font-bold text-red-600' : ''}">${fmtDate(c.due_at)}</td>
                <td class="text-right font-bold">${money(c.amount)}</td>
                <td><span class="px-2 py-1 rounded-full text-[10px] font-bold ${badge.c}">${badge.t}</span></td>
                <td class="text-right">
                  ${c.status === 'pending' ? `<button data-mark-paid="${c.id}" class="text-xs text-green-700 hover:underline">Marcar pagado</button> · <button data-mark-bounced="${c.id}" class="text-xs text-red-600 hover:underline">Rebotar</button> · ` : ''}
                  <button data-edit="${c.id}" class="text-xs text-[#d82f1e] hover:underline">Editar</button>
                  <button data-del="${c.id}" class="text-xs text-[#7d6c5c] hover:text-red-600 ml-1">Borrar</button>
                </td>
              </tr>
            `;
          }).join('') : emptyRow(8, { icon: 'receipt_long', title: 'Sin cheques', hint: 'Registrá un cheque a proveedor para controlar vencimientos y alertas automáticas.', ctaLabel: 'Nuevo cheque', ctaAttr: 'data-empty-new="check"' })}
        </tbody>
      </table>
    </div>
  `;

  el.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => { state.tab = b.dataset.tab; render(el); }));
  el.querySelector('#ch-new').addEventListener('click', () => editCheck(el, null, suppliers));
  el.querySelector('[data-empty-new="check"]')?.addEventListener('click', () => editCheck(el, null, suppliers));
  el.querySelector('#ch-export').addEventListener('click', () => {
    exportSimple(`cheques.xlsx`, filtered.map(c => ({
      Numero: c.number, Proveedor: supMap[c.supplier_id] || '', Banco: c.bank || '',
      Emision: fmtDate(c.issued_at), Vence: fmtDate(c.due_at), Monto: c.amount, Estado: c.status,
    })), 'Cheques');
  });
  el.querySelectorAll('[data-mark-paid]').forEach(b => b.addEventListener('click', () => markStatus(el, b.dataset.markPaid, 'paid')));
  el.querySelectorAll('[data-mark-bounced]').forEach(b => b.addEventListener('click', () => markStatus(el, b.dataset.markBounced, 'bounced')));
  el.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', async () => {
    const c = checks.find(x => x.id === b.dataset.edit);
    editCheck(el, c, suppliers);
  }));
  el.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    const ok = await confirmModal({ title: 'Borrar', message: '¿Eliminar este cheque?', danger: true, confirmLabel: 'Borrar' });
    if (!ok) return;
    await del('checks', b.dataset.del);
    await Audit.log({ action: 'delete', entity: 'cheque', entity_id: b.dataset.del, description: 'Cheque eliminado' });
    render(el);
  }));
}

function tabBtn(id, label, icon) {
  const active = state.tab === id;
  return `<button data-tab="${id}" class="flex items-center gap-2 px-3 py-2 font-bold text-sm border-b-2 transition-all ${active ? 'border-[#d82f1e] text-[#d82f1e]' : 'border-transparent text-[#7d6c5c] hover:text-[#d82f1e]'}">
    <span class="material-symbols-outlined text-base">${icon}</span>${label}
  </button>`;
}

async function editCheck(root, existing, suppliers) {
  const isNew = !existing;
  const c = existing || {
    id: newId('chk'),
    number: '', supplier_id: suppliers[0]?.id || '', bank: '',
    issued_at: new Date().toISOString().slice(0, 10),
    due_at: new Date().toISOString().slice(0, 10),
    amount: 0, status: 'pending', note: '',
    branch_id: activeBranchId(),
  };
  await openModal({
    title: isNew ? 'Nuevo cheque' : `Editar cheque #${c.number}`,
    size: 'md',
    bodyHTML: `
      <div class="grid grid-cols-2 gap-3">
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Número</label><input id="ch-num" value="${c.number}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Banco</label><input id="ch-bank" value="${c.bank || ''}" class="ing-input w-full mt-1" placeholder="Banco Nación, Galicia, etc." /></div>
        <div class="col-span-2"><label class="text-xs font-bold text-[#7d6c5c] uppercase">Proveedor</label>
          <select id="ch-sup" class="ing-input w-full mt-1">${suppliers.map(s => `<option value="${s.id}" ${c.supplier_id===s.id?'selected':''}>${s.name}</option>`).join('')}</select>
        </div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Emisión</label><input id="ch-issued" type="date" value="${c.issued_at}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Vence</label><input id="ch-due" type="date" value="${c.due_at}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Monto</label><input id="ch-amt" type="number" step="0.01" value="${c.amount}" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Estado</label>
          <select id="ch-st" class="ing-input w-full mt-1">
            <option value="pending" ${c.status==='pending'?'selected':''}>Pendiente</option>
            <option value="paid" ${c.status==='paid'?'selected':''}>Pagado</option>
            <option value="bounced" ${c.status==='bounced'?'selected':''}>Rebotado</option>
          </select>
        </div>
        <div class="col-span-2"><label class="text-xs font-bold text-[#7d6c5c] uppercase">Nota</label><input id="ch-note" value="${c.note || ''}" class="ing-input w-full mt-1" /></div>
      </div>
    `,
    footerHTML: `<button class="ing-btn-secondary" data-act="cancel">Cancelar</button><button class="ing-btn-primary" data-act="ok">${isNew ? 'Crear' : 'Guardar'}</button>`,
    onOpen: (m, close) => {
      m.querySelector('[data-act="cancel"]').addEventListener('click', () => close(false));
      m.querySelector('[data-act="ok"]').addEventListener('click', async () => {
        c.number = m.querySelector('#ch-num').value.trim() || newId('ch');
        c.supplier_id = m.querySelector('#ch-sup').value;
        c.bank = m.querySelector('#ch-bank').value.trim();
        c.issued_at = m.querySelector('#ch-issued').value;
        c.due_at = m.querySelector('#ch-due').value;
        c.amount = Number(m.querySelector('#ch-amt').value) || 0;
        c.status = m.querySelector('#ch-st').value;
        c.note = m.querySelector('#ch-note').value;
        await put('checks', c);
        await Audit.log({ action: isNew ? 'create' : 'update', entity: 'cheque', entity_id: c.id, after: c, description: `Cheque #${c.number} ${money(c.amount)}` });
        if (isNew && c.status === 'pending' && daysUntil(c.due_at) <= 7) {
          await push({ title: 'Cheque próximo a vencer', body: `#${c.number} · ${money(c.amount)} · vence ${fmtDate(c.due_at)}`, type: 'warn' });
        }
        toast(isNew ? 'Cheque creado' : 'Cheque actualizado', 'success');
        close(true);
      });
    },
  });
  render(root);
}

async function markStatus(root, id, status) {
  const all = await getAll('checks');
  const c = all.find(x => x.id === id);
  if (!c) return;

  // G-5: cheque pagado → genera movimiento de caja de salida (una sola vez)
  if (status === 'paid' && !c.cash_movement_id) {
    if (!(await Cash.isDayOpen(c.branch_id))) {
      toast('Abrí la caja antes de marcar el cheque como pagado', 'error');
      return;
    }
    const ok = await confirmModal({
      title: 'Marcar cheque como pagado',
      message: `Se va a registrar una salida de caja de ${money(c.amount)} por el cheque #${c.number}. ¿Confirmar?`,
      confirmLabel: 'Sí, pagar',
    });
    if (!ok) return;
    const mv = await Cash.move({
      branchId: c.branch_id, type: 'check_payment',
      amountOut: Number(c.amount) || 0,
      description: `Cheque #${c.number} pagado`,
      refId: c.id,
      userId: currentSession()?.user_id,
    });
    c.cash_movement_id = mv.id;
    c.paid_at = new Date().toISOString();
  }

  c.status = status;
  await put('checks', c);
  await Audit.log({ action: 'update', entity: 'cheque', entity_id: id, after: c, description: `Estado → ${status}` });
  if (status === 'bounced') await push({ title: 'Cheque rebotado', body: `#${c.number} · ${money(c.amount)}`, type: 'error' });
  toast(status === 'paid' ? 'Cheque pagado · caja actualizada' : 'Actualizado', 'success');
  render(root);
}

function daysUntil(isoDate) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(isoDate); d.setHours(0, 0, 0, 0);
  return Math.round((d - today) / 86400000);
}

// Lanza notificaciones al montar para cheques próximos/vencidos
async function checkUpcoming() {
  const [checks, notifs] = await Promise.all([getAll('checks'), getAll('notifications')]);
  const today = new Date().toISOString().slice(0, 10);
  const session = currentSession();
  for (const c of checks) {
    if (c.status !== 'pending') continue;
    const already = notifs.some(n => (n.body || '').includes(c.number) && n.datetime.startsWith(today));
    if (already) continue;
    const days = daysUntil(c.due_at);
    if (days <= 0) await push({ title: 'Cheque VENCIDO', body: `#${c.number} · ${money(c.amount)}`, type: 'error', branch_id: c.branch_id });
    else if (days <= 3) await push({ title: `Cheque vence en ${days}d`, body: `#${c.number} · ${money(c.amount)}`, type: 'warn', branch_id: c.branch_id });
  }
}
