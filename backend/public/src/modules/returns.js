// Devoluciones — procesa los 5 casos: devolución pura, cambio mismo valor,
// cambio a más caro (cliente paga diferencia), cambio a más barato (le damos efvo
// o emitimos vale), devolución con vale.

import * as Returns from '../repos/returns.js';
import * as P from '../repos/products.js';
import { getAll, get } from '../core/db.js';
import { money, round2, fmtDateTime } from '../core/format.js';
import { openModal, confirmModal } from '../components/modal.js';
import { toast } from '../core/notifications.js';
import { activeBranchId, currentSession } from '../core/auth.js';
import { on, EV } from '../core/events.js';

const state = {
  tab: 'new',
  data: null,
  // Builder
  returned: [],      // items que devuelven
  taken: [],         // items que se llevan
  refund_payments: [],
  customer_id: null,
  original_sale_id: null,
  reason: '',
  emit_credit_note: false,
};

export async function mount(el) {
  state.data = await loadData();
  render(el);
  on(EV.RETURN_CONFIRMED, async () => { state.data = await loadData(); render(el); });
}

async function loadData() {
  const [products, stocks, customers, sales, returns, creditNotes, methodsCfg] = await Promise.all([
    P.list(), getAll('stock'), getAll('customers'), getAll('sales'),
    getAll('returns'), getAll('credit_notes'), get('config', 'payment_methods'),
  ]);
  return { products, stocks, customers, sales, returns, creditNotes, methods: methodsCfg?.value || [] };
}

function render(el) {
  el.innerHTML = `
    <div class="mb-6 flex justify-between items-center">
      <div>
        <h1 class="text-3xl font-black text-[#241a0d]">Devoluciones</h1>
        <p class="text-sm text-[#7d6c5c] mt-1">Procesá devoluciones, cambios y emitimos vales</p>
      </div>
    </div>
    <div class="flex gap-2 mb-6 border-b border-[#fff1e6]">
      ${tabBtn('new','Nueva devolución','add_circle')}
      ${tabBtn('history','Historial','history')}
      ${tabBtn('credits','Vales','local_activity')}
    </div>
    <div id="ret-content"></div>
  `;
  el.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => { state.tab = b.dataset.tab; render(el); }));
  const c = el.querySelector('#ret-content');
  if (state.tab === 'new') renderNew(c);
  if (state.tab === 'history') renderHistory(c);
  if (state.tab === 'credits') renderCredits(c);
}

function tabBtn(id, label, icon) {
  const active = state.tab === id;
  return `<button data-tab="${id}" class="flex items-center gap-2 px-4 py-3 font-bold text-sm border-b-2 transition-all ${active ? 'border-[#d82f1e] text-[#d82f1e]' : 'border-transparent text-[#7d6c5c] hover:text-[#d82f1e]'}">
    <span class="material-symbols-outlined text-base">${icon}</span>${label}
  </button>`;
}

// ===== NUEVA =====
function renderNew(container) {
  const retTotal = totalOf(state.returned);
  const takTotal = totalOf(state.taken);
  const difference = round2(takTotal - retTotal); // >0 cliente paga · <0 le damos
  const hasItems = state.returned.length > 0 || state.taken.length > 0;
  const paymentsNet = round2(state.refund_payments.reduce((s, p) => s + (Number(p.amount) || 0), 0));
  const invoicedDelta = hasItems ? difference : paymentsNet;
  const cashNet = round2(state.refund_payments.reduce((s, p) => {
    const m = state.data.methods.find(x => x.id === p.method_id);
    return s + (m?.affects_cash ? (Number(p.amount) || 0) : 0);
  }, 0));
  // Monto a resolver con pagos
  const amountToSettle = hasItems ? difference : paymentsNet;
  const needsPayments = hasItems ? (Math.abs(difference) > 0.01 && !state.emit_credit_note) : true;

  container.innerHTML = `
    <div class="grid grid-cols-[1fr_400px] gap-5">
      <div class="space-y-5">
        <div class="ing-card p-4">
          <div class="flex items-center justify-between mb-3">
            <h3 class="font-black text-lg flex items-center gap-2"><span class="material-symbols-outlined text-[#d82f1e]">undo</span> Productos que devuelve</h3>
            <button id="add-returned" class="ing-btn-secondary text-sm flex items-center gap-1"><span class="material-symbols-outlined text-base">add</span> Agregar</button>
          </div>
          ${itemsList(state.returned, 'returned')}
          <div class="text-right text-sm mt-2"><span class="text-[#7d6c5c]">Subtotal devolución:</span> <span class="font-bold">${money(retTotal)}</span></div>
        </div>

        <div class="ing-card p-4">
          <div class="flex items-center justify-between mb-3">
            <h3 class="font-black text-lg flex items-center gap-2"><span class="material-symbols-outlined text-green-600">redo</span> Se lleva a cambio</h3>
            <button id="add-taken" class="ing-btn-secondary text-sm flex items-center gap-1"><span class="material-symbols-outlined text-base">add</span> Agregar</button>
          </div>
          ${itemsList(state.taken, 'taken')}
          <div class="text-right text-sm mt-2"><span class="text-[#7d6c5c]">Subtotal que se lleva:</span> <span class="font-bold">${money(takTotal)}</span></div>
        </div>

        ${!hasItems ? `
        <div class="ing-card p-4 border-2 border-dashed border-[#f5dfca]">
          <div class="flex items-center gap-2 mb-2">
            <span class="material-symbols-outlined text-[#d82f1e]">payments</span>
            <h3 class="font-black text-lg">Devolución sin productos</h3>
          </div>
          <p class="text-sm text-[#7d6c5c]">Registrá el monto a devolver y los medios de pago abajo. Se descuenta de lo facturado.</p>
        </div>
        ` : ''}
      </div>

      <div class="space-y-4">
        <div class="ing-card p-4 sticky top-4">
          <h3 class="font-black text-lg mb-3">Resumen</h3>
          <div class="bg-[#fff8f4] rounded-xl p-3 text-sm space-y-1 mb-3">
            ${hasItems ? `
              <div class="flex justify-between"><span class="text-[#7d6c5c]">Devuelve</span><span>${money(retTotal)}</span></div>
              <div class="flex justify-between"><span class="text-[#7d6c5c]">Lleva</span><span>${money(takTotal)}</span></div>
              <div class="flex justify-between border-t border-[#fff1e6] pt-1 mt-1 font-bold">
                <span>Diferencia</span>
                <span class="${difference > 0 ? 'text-orange-600' : difference < 0 ? 'text-green-700' : ''}">${money(difference)}</span>
              </div>
            ` : `
              <div class="flex justify-between"><span class="text-[#7d6c5c]">Monto pagos</span><span>${money(paymentsNet)}</span></div>
            `}
            <div class="flex justify-between text-xs border-t border-[#fff1e6] pt-1 mt-1">
              <span class="text-[#7d6c5c]">Impacto facturado</span>
              <span class="${invoicedDelta < 0 ? 'text-red-600 font-bold' : invoicedDelta > 0 ? 'text-green-700 font-bold' : ''}">${money(invoicedDelta)}</span>
            </div>
            <div class="flex justify-between text-xs">
              <span class="text-[#7d6c5c]">Impacto caja (solo efvo)</span>
              <span class="${cashNet < 0 ? 'text-red-600 font-bold' : cashNet > 0 ? 'text-green-700 font-bold' : ''}">${money(cashNet)}</span>
            </div>
          </div>
          <div class="text-xs text-[#7d6c5c] mb-3">
            ${differenceHelp(difference, hasItems)}
          </div>

          <div class="space-y-3">
            <div>
              <label class="text-xs font-bold text-[#7d6c5c] uppercase">Cliente</label>
              <select id="r-cust" class="ing-input w-full mt-1">
                <option value="">— Sin cliente —</option>
                ${state.data.customers.map(c => `<option value="${c.id}" ${state.customer_id===c.id?'selected':''}>${c.name} ${c.lastname||''}</option>`).join('')}
              </select>
            </div>
            <div>
              <label class="text-xs font-bold text-[#7d6c5c] uppercase">Motivo</label>
              <input id="r-reason" value="${state.reason}" class="ing-input w-full mt-1" placeholder="Defecto, cambio de talle…" />
            </div>
            <div>
              <label class="text-xs font-bold text-[#7d6c5c] uppercase">Venta original (opcional)</label>
              <select id="r-sale" class="ing-input w-full mt-1">
                <option value="">— N/A —</option>
                ${state.data.sales.slice(-30).reverse().map(s => `<option value="${s.id}" ${state.original_sale_id===s.id?'selected':''}>#${s.number} · ${fmtDateTime(s.datetime)} · ${money(s.total)}</option>`).join('')}
              </select>
            </div>

            ${hasItems && difference < 0 ? `
              <label class="flex items-center gap-2 cursor-pointer p-2 rounded-lg ${state.emit_credit_note ? 'bg-[#fff1e6]' : 'hover:bg-[#fff8f4]'}">
                <input type="checkbox" id="r-cn" ${state.emit_credit_note ? 'checked' : ''} />
                <span class="text-sm"><strong>Emitir vale</strong> por ${money(Math.abs(difference))} (en vez de devolver efvo)</span>
              </label>
            ` : ''}

            ${needsPayments ? `
              <div>
                <div class="flex items-center justify-between mb-1">
                  <label class="text-xs font-bold text-[#7d6c5c] uppercase">Medios de pago ${state.refund_payments.length > 1 ? '(múltiple)' : ''}</label>
                  <div class="flex gap-1">
                    <button id="r-add-pay" class="text-xs font-bold text-[#d82f1e]" title="Agregar otro medio">+ Medio</button>
                  </div>
                </div>
                ${state.refund_payments.length === 0 ? `
                  <div class="text-xs text-[#7d6c5c] p-3 border border-dashed border-[#fff1e6] rounded-xl text-center mb-2">
                    Todavía no hay pagos. ${hasItems ? `Sugerido: ${money(amountToSettle)}` : ''}
                  </div>
                ` : ''}
                <div class="space-y-2">
                  ${state.refund_payments.map((p, i) => `
                    <div class="flex gap-2">
                      <select data-pay-method="${i}" class="ing-input flex-1">
                        ${state.data.methods.map(m => `<option value="${m.id}" ${p.method_id===m.id?'selected':''}>${m.name}${m.affects_cash ? ' · efvo' : ''}</option>`).join('')}
                      </select>
                      <input data-pay-amount="${i}" type="number" step="0.01" value="${p.amount}" class="ing-input w-28 text-right" />
                      <button data-pay-rm="${i}" class="w-8 h-8 rounded-md text-[#7d6c5c] hover:text-red-600 flex items-center justify-center"><span class="material-symbols-outlined text-base">close</span></button>
                    </div>
                  `).join('')}
                </div>
                <p class="text-[10px] text-[#7d6c5c] mt-1">Positivo = cliente paga · Negativo = le devolvemos</p>
              </div>
            ` : ''}
          </div>

          <div class="mt-4 space-y-2">
            <button id="r-confirm" class="w-full ing-btn-primary flex items-center justify-center gap-2 py-3">
              <span class="material-symbols-outlined">check_circle</span> Procesar devolución
            </button>
            <button id="r-reset" class="w-full text-sm text-[#7d6c5c] hover:text-red-600">Cancelar y vaciar</button>
          </div>
        </div>
      </div>
    </div>
  `;

  container.querySelector('#add-returned').addEventListener('click', () => pickItem(container, 'returned'));
  container.querySelector('#add-taken').addEventListener('click', () => pickItem(container, 'taken'));
  container.querySelector('#r-cust').addEventListener('change', (ev) => { state.customer_id = ev.target.value || null; });
  container.querySelector('#r-reason').addEventListener('change', (ev) => { state.reason = ev.target.value; });
  container.querySelector('#r-sale').addEventListener('change', (ev) => { state.original_sale_id = ev.target.value || null; });
  container.querySelector('#r-reset').addEventListener('click', async () => {
    const ok = await confirmModal({ title: 'Cancelar', message: '¿Descartar la devolución en curso?', danger: true, confirmLabel: 'Descartar' });
    if (ok) { resetBuilder(); render(container.closest('#main-content') || container.parentElement); }
  });
  container.querySelector('#r-confirm').addEventListener('click', () => confirmReturn(container));

  container.querySelectorAll('[data-item-qty]').forEach(inp => inp.addEventListener('change', (ev) => {
    const i = Number(inp.dataset.itemQty); const list = inp.dataset.itemList;
    state[list][i].qty = Math.max(1, Number(ev.target.value) || 1); render(container.closest('#main-content') || container.parentElement);
  }));
  container.querySelectorAll('[data-item-price]').forEach(inp => inp.addEventListener('change', (ev) => {
    const i = Number(inp.dataset.itemPrice); const list = inp.dataset.itemList;
    state[list][i].unit_price = Math.max(0, Number(ev.target.value) || 0); render(container.closest('#main-content') || container.parentElement);
  }));
  container.querySelectorAll('[data-item-rm]').forEach(b => b.addEventListener('click', () => {
    const i = Number(b.dataset.itemRm); const list = b.dataset.itemList;
    state[list].splice(i, 1); render(container.closest('#main-content') || container.parentElement);
  }));

  const cn = container.querySelector('#r-cn');
  if (cn) cn.addEventListener('change', (ev) => { state.emit_credit_note = ev.target.checked; render(container.closest('#main-content') || container.parentElement); });
  const addPay = container.querySelector('#r-add-pay');
  if (addPay) addPay.addEventListener('click', () => {
    const suggested = hasItems
      ? round2(amountToSettle - paymentsNet)
      : 0;
    state.refund_payments.push({ method_id: state.data.methods[0]?.id || 'cash', amount: suggested });
    render(container.closest('#main-content') || container.parentElement);
  });
  container.querySelectorAll('[data-pay-method]').forEach(s => s.addEventListener('change', (ev) => { const i = Number(s.dataset.payMethod); state.refund_payments[i].method_id = ev.target.value; }));
  container.querySelectorAll('[data-pay-amount]').forEach(inp => inp.addEventListener('change', (ev) => { const i = Number(inp.dataset.payAmount); state.refund_payments[i].amount = Number(ev.target.value) || 0; }));
  container.querySelectorAll('[data-pay-rm]').forEach(b => b.addEventListener('click', () => { const i = Number(b.dataset.payRm); state.refund_payments.splice(i, 1); render(container.closest('#main-content') || container.parentElement); }));
}

function itemsList(list, key) {
  if (!list.length) return `<div class="text-sm text-[#7d6c5c] p-4 text-center border border-dashed border-[#fff1e6] rounded-xl">Sin items. Click en "+ Agregar".</div>`;
  return `
    <div class="border border-[#fff1e6] rounded-xl overflow-hidden">
      <div class="grid grid-cols-[1fr_80px_120px_120px_40px] gap-2 px-3 py-2 bg-[#fff8f4] text-xs font-bold text-[#7d6c5c] uppercase">
        <div>Producto</div><div class="text-center">Cant.</div><div class="text-right">Precio</div><div class="text-right">Subtotal</div><div></div>
      </div>
      ${list.map((it, i) => `
        <div class="grid grid-cols-[1fr_80px_120px_120px_40px] gap-2 px-3 py-2 items-center border-t border-[#fff1e6]">
          <div class="min-w-0"><div class="font-bold text-sm truncate">${it.name}</div><div class="text-xs text-[#7d6c5c] font-mono">${it.code || ''}</div></div>
          <input data-item-qty="${i}" data-item-list="${key}" type="number" min="1" value="${it.qty}" class="w-full h-8 text-center border border-[#fff1e6] rounded-md text-sm" />
          <input data-item-price="${i}" data-item-list="${key}" type="number" step="0.01" value="${it.unit_price}" class="w-full h-8 text-right border border-[#fff1e6] rounded-md text-sm" />
          <div class="text-right font-bold">${money((it.qty || 0) * (it.unit_price || 0))}</div>
          <button data-item-rm="${i}" data-item-list="${key}" class="w-7 h-7 rounded-md text-[#7d6c5c] hover:text-red-600 flex items-center justify-center"><span class="material-symbols-outlined text-base">close</span></button>
        </div>
      `).join('')}
    </div>
  `;
}

function totalOf(items) {
  return round2(items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.unit_price) || 0), 0));
}

function differenceHelp(difference, hasItems) {
  if (!hasItems) return '<span class="text-[#7d6c5c]">Devolución pura: se descuenta de lo facturado. Si es en efectivo, también de la caja.</span>';
  if (Math.abs(difference) < 0.01) return '<span class="text-green-700">✓ Cambio a valor exacto · sin movimiento de dinero.</span>';
  if (difference > 0) return `<span class="text-orange-700">Cliente paga diferencia de ${money(difference)}.</span>`;
  return `<span class="text-green-700">Queda a favor del cliente ${money(Math.abs(difference))}. Elegí vale o devolución en efvo.</span>`;
}

async function pickItem(container, listKey) {
  const br = activeBranchId();
  await openModal({
    title: listKey === 'returned' ? 'Agregar producto a devolver' : 'Agregar producto a cambio',
    size: 'lg',
    bodyHTML: `
      <input id="pick-q" placeholder="Buscar nombre o código…" class="ing-input w-full mb-3" />
      <div id="pick-grid" class="grid grid-cols-3 gap-2 max-h-[50vh] overflow-y-auto"></div>
    `,
    footerHTML: `<button class="ing-btn-secondary" data-act="close">Cerrar</button>`,
    onOpen: (el, close) => {
      const grid = el.querySelector('#pick-grid');
      const draw = () => {
        const q = el.querySelector('#pick-q').value.trim().toLowerCase();
        const list = state.data.products.filter(p => !q || p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q)).slice(0, 30);
        grid.innerHTML = list.map(p => {
          const st = state.data.stocks.find(s => s.product_id === p.id && s.branch_id === br);
          return `<button data-pid="${p.id}" class="text-left border border-[#fff1e6] rounded-xl p-2 hover:border-[#d82f1e]">
            <div class="font-bold text-sm truncate">${p.name}</div>
            <div class="text-xs text-[#7d6c5c] font-mono">${p.code}</div>
            <div class="text-xs mt-1 flex justify-between"><span>Stock: ${st?.qty || 0}</span><span class="font-bold text-[#d82f1e]">${money(p.price)}</span></div>
          </button>`;
        }).join('') || '<div class="col-span-3 text-center p-4 text-[#7d6c5c]">Sin resultados</div>';
        grid.querySelectorAll('[data-pid]').forEach(b => b.addEventListener('click', () => {
          const p = state.data.products.find(x => x.id === b.dataset.pid);
          if (p) {
            state[listKey].push({ product_id: p.id, name: p.name, code: p.code, qty: 1, unit_price: Number(p.price) || 0, cost_snapshot: Number(p.cost) || 0 });
            close(true);
          }
        }));
      };
      el.querySelector('#pick-q').addEventListener('input', draw);
      el.querySelector('[data-act="close"]').addEventListener('click', () => close(false));
      draw();
    },
  });
  render(container.closest('#main-content') || container.parentElement);
}

async function confirmReturn(container) {
  const hasItems = state.returned.length > 0 || state.taken.length > 0;
  const hasPayments = state.refund_payments.some(p => (Number(p.amount) || 0) !== 0);
  if (!hasItems && !hasPayments) { toast('Agregá productos o un monto de devolución', 'warn'); return; }

  const retTotal = totalOf(state.returned);
  const takTotal = totalOf(state.taken);
  const difference = round2(takTotal - retTotal);

  // Validar pagos cuando hay items y no es vale
  if (hasItems && Math.abs(difference) > 0.01 && !state.emit_credit_note) {
    const sumP = round2(state.refund_payments.reduce((s, p) => s + (Number(p.amount) || 0), 0));
    if (Math.abs(sumP - difference) > 0.01) {
      toast(`Los pagos (${money(sumP)}) no coinciden con la diferencia (${money(difference)})`, 'error');
      return;
    }
  }
  // En devolución pura, los pagos deben existir y ser distintos de cero
  if (!hasItems) {
    const sumP = round2(state.refund_payments.reduce((s, p) => s + (Number(p.amount) || 0), 0));
    if (Math.abs(sumP) < 0.01) {
      toast('Ingresá un monto distinto de cero en los medios de pago', 'error');
      return;
    }
  }
  try {
    const session = currentSession();
    await Returns.process({
      returned_items: state.returned,
      taken_items: state.taken,
      refund_payments: state.refund_payments,
      emit_credit_note: state.emit_credit_note,
      customer_id: state.customer_id,
      original_sale_id: state.original_sale_id,
      reason: state.reason,
      branchId: activeBranchId(),
      userId: session.user_id,
    });
    toast('Devolución procesada', 'success');
    resetBuilder();
    state.data = await loadData();
    render(container.closest('#main-content') || container.parentElement);
  } catch (err) {
    toast('Error: ' + err.message, 'error');
  }
}

function resetBuilder() {
  state.returned = []; state.taken = []; state.refund_payments = [];
  state.customer_id = null; state.original_sale_id = null; state.reason = ''; state.emit_credit_note = false;
}

// ===== HISTORIAL =====
function renderHistory(container) {
  const list = state.data.returns.slice().sort((a, b) => b.datetime.localeCompare(a.datetime));
  container.innerHTML = `
    <div class="ing-card overflow-hidden">
      <div class="grid grid-cols-[80px_150px_1fr_110px_110px_110px_120px_90px] gap-3 px-4 py-3 bg-[#fff8f4] text-xs font-bold uppercase text-[#7d6c5c]">
        <div>#</div><div>Fecha</div><div>Cliente</div><div class="text-right">Devuelve</div><div class="text-right">Lleva</div><div class="text-right">Dif</div><div class="text-right">Facturado</div><div>Vale</div>
      </div>
      ${list.length ? list.map(r => {
        const cust = state.data.customers.find(c => c.id === r.customer_id);
        const invDelta = r.invoiced_delta != null ? r.invoiced_delta : r.difference;
        return `
        <div class="grid grid-cols-[80px_150px_1fr_110px_110px_110px_120px_90px] gap-3 px-4 py-3 border-t border-[#fff1e6] items-center hover:bg-[#fff8f4]">
          <div class="font-mono font-bold">#${r.number}</div>
          <div class="text-xs">${fmtDateTime(r.datetime)}</div>
          <div>${cust ? `${cust.name} ${cust.lastname||''}` : '<span class="text-[#7d6c5c]">—</span>'}</div>
          <div class="text-right font-bold">${money(r.returned_total)}</div>
          <div class="text-right">${money(r.taken_total)}</div>
          <div class="text-right font-bold ${r.difference > 0 ? 'text-orange-600' : r.difference < 0 ? 'text-green-700' : ''}">${money(r.difference)}</div>
          <div class="text-right font-bold ${invDelta < 0 ? 'text-red-600' : invDelta > 0 ? 'text-green-700' : 'text-[#7d6c5c]'}">${money(invDelta)}</div>
          <div class="text-xs">${r.credit_note_code ? `<span class="bg-[#fff1e6] text-[#d82f1e] px-2 py-1 rounded-full font-bold">${r.credit_note_code}</span>` : '—'}</div>
        </div>
      `; }).join('') : '<div class="p-8 text-center text-[#7d6c5c]">Sin devoluciones aún</div>'}
    </div>
  `;
}

// ===== VALES =====
function renderCredits(container) {
  const list = state.data.creditNotes.slice().sort((a, b) => b.issued_at.localeCompare(a.issued_at));
  container.innerHTML = `
    <div class="ing-card overflow-hidden">
      <div class="grid grid-cols-[140px_1fr_120px_140px_140px_120px] gap-3 px-4 py-3 bg-[#fff8f4] text-xs font-bold uppercase text-[#7d6c5c]">
        <div>Código</div><div>Cliente</div><div class="text-right">Monto</div><div>Emitido</div><div>Vence</div><div>Estado</div>
      </div>
      ${list.length ? list.map(cn => {
        const cust = state.data.customers.find(c => c.id === cn.customer_id);
        const expired = cn.expires_at && cn.expires_at < new Date().toISOString();
        const status = cn.redeemed_at ? { t: 'Canjeado', c: 'text-[#7d6c5c]' } : expired ? { t: 'Vencido', c: 'text-red-600' } : { t: 'Activo', c: 'text-green-700 font-bold' };
        return `
          <div class="grid grid-cols-[140px_1fr_120px_140px_140px_120px] gap-3 px-4 py-3 border-t border-[#fff1e6] items-center hover:bg-[#fff8f4]">
            <div class="font-mono font-bold text-[#d82f1e]">${cn.code}</div>
            <div>${cust ? `${cust.name} ${cust.lastname||''}` : '—'}</div>
            <div class="text-right font-bold">${money(cn.amount)}</div>
            <div class="text-xs">${fmtDateTime(cn.issued_at)}</div>
            <div class="text-xs">${fmtDateTime(cn.expires_at)}</div>
            <div class="text-xs ${status.c}">${status.t}</div>
          </div>
        `;
      }).join('') : '<div class="p-8 text-center text-[#7d6c5c]">Sin vales emitidos</div>'}
    </div>
  `;
}
