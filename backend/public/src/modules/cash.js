// Caja — movimientos en efvo, apertura/cierre diario, gastos.
// Tabs: Movimientos | Gastos | Apertura/Cierre.

import * as Cash from '../repos/cash.js';
import { getAll, get } from '../core/db.js';
import { money, fmtDateTime, todayKey } from '../core/format.js';
import { activeBranchId, currentSession } from '../core/auth.js';
import { openModal, confirmModal } from '../components/modal.js';
import { toast } from '../core/notifications.js';
import { on, EV } from '../core/events.js';
import { exportSimple } from '../core/xlsx.js';

const state = {
  tab: 'moves',
  filters: { type: '', date: '' },
};

export async function mount(el) {
  render(el);
  on(EV.CASH_MOVED, () => render(el));
}

async function render(el) {
  const branchId = activeBranchId();
  const [all, expenses, methodsCfg] = await Promise.all([getAll('cash_movements'), getAll('expenses'), get('config', 'payment_methods')]);
  const moves = all.filter(m => m.branch_id === branchId).sort((a, b) => b.datetime.localeCompare(a.datetime));
  const balance = moves.reduce((s, m) => s + (m.amount_in || 0) - (m.amount_out || 0), 0);
  const methods = methodsCfg?.value || [];

  const todayMoves = moves.filter(m => m.datetime.startsWith(todayKey()));
  const todayIn = todayMoves.reduce((s, m) => s + (m.amount_in || 0), 0);
  const todayOut = todayMoves.reduce((s, m) => s + (m.amount_out || 0), 0);
  const openedToday = todayMoves.some(m => m.type === 'opening');
  const closedToday = todayMoves.some(m => m.type === 'closing');

  el.innerHTML = `
    <div class="mb-6 flex justify-between items-start gap-4">
      <div>
        <h1 class="text-3xl font-black text-[#241a0d]">Caja</h1>
        <p class="text-sm text-[#7d6c5c] mt-1">Movimientos en efectivo · Sucursal activa</p>
      </div>
      <div class="grid grid-cols-3 gap-3">
        <div class="ing-card text-center py-3 px-4">
          <div class="text-[10px] font-black text-[#7d6c5c] uppercase">Saldo actual</div>
          <div class="text-2xl font-black text-[#d82f1e]">${money(balance)}</div>
        </div>
        <div class="ing-card text-center py-3 px-4">
          <div class="text-[10px] font-black text-[#7d6c5c] uppercase">Hoy entra</div>
          <div class="text-xl font-black text-green-700">${money(todayIn)}</div>
        </div>
        <div class="ing-card text-center py-3 px-4">
          <div class="text-[10px] font-black text-[#7d6c5c] uppercase">Hoy sale</div>
          <div class="text-xl font-black text-red-600">${money(todayOut)}</div>
        </div>
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-2 mb-4">
      <button id="c-open" class="ing-btn-primary flex items-center gap-2" ${openedToday ? 'disabled style="opacity:.5"' : ''}>
        <span class="material-symbols-outlined text-base">lock_open</span> Apertura de caja
      </button>
      <button id="c-close" class="ing-btn-secondary flex items-center gap-2" ${closedToday || !openedToday ? 'disabled style="opacity:.5"' : ''}>
        <span class="material-symbols-outlined text-base">lock</span> Cierre de caja
      </button>
      <button id="c-expense" class="ing-btn-secondary flex items-center gap-2">
        <span class="material-symbols-outlined text-base">shopping_bag</span> Registrar gasto
      </button>
      <button id="c-manual" class="ing-btn-secondary flex items-center gap-2">
        <span class="material-symbols-outlined text-base">edit</span> Ajuste manual
      </button>
      <div class="flex-1"></div>
      <button id="c-export" class="ing-btn-secondary flex items-center gap-2">
        <span class="material-symbols-outlined text-base">download</span> Exportar XLSX
      </button>
    </div>

    <div class="flex gap-2 mb-4 border-b border-[#fff1e6]">
      ${tabBtn('moves', 'Movimientos', 'receipt_long')}
      ${tabBtn('expenses', 'Gastos', 'shopping_bag')}
    </div>

    <div id="c-content"></div>
  `;

  el.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => { state.tab = b.dataset.tab; render(el); }));
  el.querySelector('#c-open').addEventListener('click', () => openDayModal(el));
  el.querySelector('#c-close').addEventListener('click', () => closeDayModal(el, balance));
  el.querySelector('#c-expense').addEventListener('click', () => expenseModal(el, methods));
  el.querySelector('#c-manual').addEventListener('click', () => manualMoveModal(el));
  el.querySelector('#c-export').addEventListener('click', () => exportMoves(moves));

  if (state.tab === 'moves') renderMoves(el.querySelector('#c-content'), moves);
  if (state.tab === 'expenses') renderExpenses(el.querySelector('#c-content'), expenses.filter(e => e.branch_id === branchId));
}

function tabBtn(id, label, icon) {
  const active = state.tab === id;
  return `<button data-tab="${id}" class="flex items-center gap-2 px-4 py-3 font-bold text-sm border-b-2 transition-all ${active ? 'border-[#d82f1e] text-[#d82f1e]' : 'border-transparent text-[#7d6c5c] hover:text-[#d82f1e]'}">
    <span class="material-symbols-outlined text-base">${icon}</span>${label}
  </button>`;
}

function renderMoves(container, moves) {
  container.innerHTML = `
    <div class="ing-card overflow-hidden">
      <table class="ing-table w-full">
        <thead>
          <tr>
            <th>Fecha</th><th>Tipo</th><th>Descripción</th>
            <th class="text-right">Entra</th><th class="text-right">Sale</th><th class="text-right">Saldo</th>
          </tr>
        </thead>
        <tbody>
          ${moves.length === 0 ? `<tr><td colspan="6" class="text-center py-8 text-[#7d6c5c]">Sin movimientos</td></tr>` :
            moves.map(m => `
              <tr>
                <td class="text-xs">${fmtDateTime(m.datetime)}</td>
                <td class="text-xs"><span class="px-2 py-1 rounded-full font-bold uppercase text-[10px] ${typeColor(m.type)}">${m.type}</span></td>
                <td class="text-sm">${m.description || '-'}</td>
                <td class="text-right font-bold text-green-700">${m.amount_in ? money(m.amount_in) : '-'}</td>
                <td class="text-right font-bold text-red-600">${m.amount_out ? money(m.amount_out) : '-'}</td>
                <td class="text-right font-black">${money(m.balance_after)}</td>
              </tr>
            `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function typeColor(t) {
  const map = {
    opening: 'bg-blue-100 text-blue-700',
    closing: 'bg-purple-100 text-purple-700',
    sale: 'bg-green-100 text-green-700',
    return: 'bg-orange-100 text-orange-700',
    expense: 'bg-red-100 text-red-700',
    manual: 'bg-gray-100 text-gray-700',
  };
  return map[t] || 'bg-[#fff1e6] text-[#7d6c5c]';
}

function renderExpenses(container, expenses) {
  const sorted = expenses.sort((a, b) => b.datetime.localeCompare(a.datetime));
  const total = sorted.reduce((s, e) => s + (Number(e.amount) || 0), 0);
  container.innerHTML = `
    <div class="mb-3 text-sm text-[#7d6c5c]">${sorted.length} gastos · Total: <strong class="text-[#d82f1e]">${money(total)}</strong></div>
    <div class="ing-card overflow-hidden">
      <table class="ing-table w-full">
        <thead><tr><th>Fecha</th><th>Categoría</th><th>Descripción</th><th>Pago</th><th class="text-right">Monto</th></tr></thead>
        <tbody>
          ${sorted.length ? sorted.map(e => `
            <tr>
              <td class="text-xs">${fmtDateTime(e.datetime)}</td>
              <td class="text-sm font-bold">${e.category}</td>
              <td class="text-sm">${e.description || '-'}</td>
              <td class="text-xs text-[#7d6c5c]">${e.payment_method_id || 'cash'}</td>
              <td class="text-right font-bold text-red-600">${money(e.amount)}</td>
            </tr>
          `).join('') : `<tr><td colspan="5" class="text-center py-8 text-[#7d6c5c]">Sin gastos</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
}

async function openDayModal(el) {
  await openModal({
    title: 'Apertura de caja',
    size: 'sm',
    bodyHTML: `
      <label class="text-xs font-bold text-[#7d6c5c] uppercase">Monto inicial en caja</label>
      <input id="od-amt" type="number" step="0.01" min="0" value="0" class="ing-input w-full mt-1" />
      <p class="text-xs text-[#7d6c5c] mt-2">El monto queda como primer movimiento del día.</p>
    `,
    footerHTML: `<button class="ing-btn-secondary" data-act="cancel">Cancelar</button><button class="ing-btn-primary" data-act="ok">Abrir</button>`,
    onOpen: (m, close) => {
      m.querySelector('#od-amt').focus();
      m.querySelector('[data-act="cancel"]').addEventListener('click', () => close(false));
      m.querySelector('[data-act="ok"]').addEventListener('click', async () => {
        const amt = Number(m.querySelector('#od-amt').value) || 0;
        try {
          await Cash.openDay(activeBranchId(), amt, currentSession().user_id);
          toast('Caja abierta', 'success'); close(true);
          render(el);
        } catch (err) { toast(err.message, 'error'); }
      });
    },
  });
}

async function closeDayModal(el, expected) {
  await openModal({
    title: 'Cierre de caja',
    size: 'sm',
    bodyHTML: `
      <div class="bg-[#fff8f4] rounded-xl p-3 text-sm mb-3">
        <div class="flex justify-between"><span class="text-[#7d6c5c]">Esperado en caja</span><span class="font-bold">${money(expected)}</span></div>
      </div>
      <label class="text-xs font-bold text-[#7d6c5c] uppercase">Contado físico</label>
      <input id="cd-amt" type="number" step="0.01" min="0" value="${expected.toFixed(2)}" class="ing-input w-full mt-1" />
      <p class="text-xs text-[#7d6c5c] mt-2">Si hay diferencia, se registra como ajuste de cierre.</p>
    `,
    footerHTML: `<button class="ing-btn-secondary" data-act="cancel">Cancelar</button><button class="ing-btn-primary" data-act="ok">Cerrar caja</button>`,
    onOpen: (m, close) => {
      m.querySelector('#cd-amt').focus(); m.querySelector('#cd-amt').select();
      m.querySelector('[data-act="cancel"]').addEventListener('click', () => close(false));
      m.querySelector('[data-act="ok"]').addEventListener('click', async () => {
        const amt = Number(m.querySelector('#cd-amt').value) || 0;
        try { await Cash.closeDay(activeBranchId(), amt, currentSession().user_id); toast('Caja cerrada', 'success'); close(true); render(el); }
        catch (err) { toast(err.message, 'error'); }
      });
    },
  });
}

async function expenseModal(el, methods) {
  await openModal({
    title: 'Registrar gasto',
    size: 'sm',
    bodyHTML: `
      <div class="space-y-3">
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Categoría</label><input id="exp-cat" placeholder="Papelería, Servicios, Mantenimiento…" class="ing-input w-full mt-1" value="General" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Descripción</label><input id="exp-desc" class="ing-input w-full mt-1" /></div>
        <div class="grid grid-cols-2 gap-3">
          <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Monto</label><input id="exp-amt" type="number" step="0.01" min="0" value="0" class="ing-input w-full mt-1" /></div>
          <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Medio</label>
            <select id="exp-method" class="ing-input w-full mt-1">
              ${methods.map(m => `<option value="${m.id}">${m.name}</option>`).join('')}
            </select>
          </div>
        </div>
        <p class="text-xs text-[#7d6c5c]">Si el pago es en efectivo impacta la caja.</p>
      </div>
    `,
    footerHTML: `<button class="ing-btn-secondary" data-act="cancel">Cancelar</button><button class="ing-btn-primary" data-act="ok">Registrar</button>`,
    onOpen: (m, close) => {
      m.querySelector('[data-act="cancel"]').addEventListener('click', () => close(false));
      m.querySelector('[data-act="ok"]').addEventListener('click', async () => {
        const payload = {
          branchId: activeBranchId(),
          amount: Number(m.querySelector('#exp-amt').value) || 0,
          category: m.querySelector('#exp-cat').value.trim() || 'General',
          description: m.querySelector('#exp-desc').value.trim(),
          paymentMethodId: m.querySelector('#exp-method').value,
          userId: currentSession().user_id,
        };
        if (!payload.amount) { toast('Monto inválido', 'warn'); return; }
        try { await Cash.addExpense(payload); toast('Gasto registrado', 'success'); close(true); render(el); }
        catch (err) { toast(err.message, 'error'); }
      });
    },
  });
}

async function manualMoveModal(el) {
  await openModal({
    title: 'Ajuste manual de caja',
    size: 'sm',
    bodyHTML: `
      <div class="space-y-3">
        <div>
          <label class="text-xs font-bold text-[#7d6c5c] uppercase">Tipo</label>
          <select id="mv-dir" class="ing-input w-full mt-1">
            <option value="in">Ingreso (+)</option>
            <option value="out">Egreso (−)</option>
          </select>
        </div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Monto</label><input id="mv-amt" type="number" step="0.01" min="0" value="0" class="ing-input w-full mt-1" /></div>
        <div><label class="text-xs font-bold text-[#7d6c5c] uppercase">Descripción</label><input id="mv-desc" class="ing-input w-full mt-1" placeholder="Motivo del ajuste" /></div>
      </div>
    `,
    footerHTML: `<button class="ing-btn-secondary" data-act="cancel">Cancelar</button><button class="ing-btn-primary" data-act="ok">Registrar</button>`,
    onOpen: (m, close) => {
      m.querySelector('[data-act="cancel"]').addEventListener('click', () => close(false));
      m.querySelector('[data-act="ok"]').addEventListener('click', async () => {
        const dir = m.querySelector('#mv-dir').value;
        const amt = Number(m.querySelector('#mv-amt').value) || 0;
        const desc = m.querySelector('#mv-desc').value.trim() || 'Ajuste manual';
        if (!amt) { toast('Monto inválido', 'warn'); return; }
        try {
          await Cash.move({
            branchId: activeBranchId(), type: 'manual',
            amountIn: dir === 'in' ? amt : 0, amountOut: dir === 'out' ? amt : 0,
            description: desc, userId: currentSession().user_id,
          });
          toast('Movimiento registrado', 'success'); close(true); render(el);
        } catch (err) { toast(err.message, 'error'); }
      });
    },
  });
}

function exportMoves(moves) {
  const rows = moves.map(m => ({
    Fecha: fmtDateTime(m.datetime),
    Tipo: m.type,
    Descripcion: m.description,
    Entra: m.amount_in || 0,
    Sale: m.amount_out || 0,
    SaldoLuego: m.balance_after || 0,
  }));
  exportSimple(`caja_${todayKey()}.xlsx`, rows, 'Caja');
  toast('Exportado', 'success');
}
