// Piezas compartidas de Señas: alta de una seña, elegir cómo se devuelve la plata y el
// comprobante. Las usan el módulo Señas, Clientes y el POS.

import { api } from '../core/api.js';
import * as Senas from '../repos/senas.js';
import * as Settings from '../repos/settings.js';
import { activeBranchId } from '../core/auth.js';
import { money, fmtDateTime } from '../core/format.js';
import { openModal } from '../components/modal.js';
import { toast } from '../core/notifications.js';
import { printHTML } from '../core/pdf.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Medios de pago del local (sin los "online": una seña se cobra en el mostrador).
export async function loadPaymentMethods() {
  const cfg = (await Settings.getConfig('payment_methods', []).catch(() => [])) || [];
  const list = cfg.filter((m) => m.kind !== 'online');
  return list.length ? list : [
    { id: 'cash', name: 'Efectivo', affects_cash: true },
    { id: 'transfer', name: 'Transferencia', affects_cash: false },
    { id: 'card', name: 'Tarjeta', affects_cash: false },
  ];
}

// Alta de una seña. Devuelve la seña creada o null si se canceló.
export async function openNewSenaModal() {
  const methods = await loadPaymentMethods();
  let customer = null;
  return openModal({
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
      <select id="sena-method" class="ing-input w-full">${methods.map((m) => `<option value="${esc(m.id)}" data-cash="${m.affects_cash ? 1 : 0}">${esc(m.name)}</option>`).join('')}</select>
      <div id="sena-cash-hint" class="text-[11px] text-[#7d6c5c] mt-1"></div>
      <label class="block text-xs font-bold text-[#7d6c5c] uppercase mb-1 mt-3">Producto / nota</label>
      <input id="sena-note" class="ing-input w-full" placeholder="Qué reserva (opcional)" />
    `,
    footerHTML: `<button class="ing-btn-secondary" data-act="cancel">Cancelar</button><button class="ing-btn-primary" data-act="ok">Crear seña</button>`,
    onOpen: (m, close) => {
      const info = m.querySelector('#sena-cust-info');
      const sel = m.querySelector('#sena-method');
      const hint = m.querySelector('#sena-cash-hint');
      const drawHint = () => {
        const cash = sel.options[sel.selectedIndex]?.dataset.cash === '1';
        hint.textContent = cash ? 'Efectivo: la seña entra a la caja de esta sucursal al crearla.' : 'Este medio no mueve la caja.';
      };
      sel.addEventListener('change', drawHint); drawHint();
      const setCustomer = (c) => {
        customer = c;
        info.innerHTML = c ? `Cliente: <b>${esc(c.name)}</b>${c.documentNumber ? ' · Doc ' + esc(c.documentNumber) : ''}` : 'Buscá el cliente.';
      };
      const doFind = async () => {
        const v = (m.querySelector('#sena-doc').value || '').trim();
        if (!v) { toast('Ingresá un documento', 'warn'); return; }
        try {
          const found = await api(`/api/customers/by-document/${encodeURIComponent(v)}`);
          if (found) { setCustomer(found); m.querySelector('#sena-amt').focus(); return; }
          const name = window.prompt('Cliente nuevo — nombre y apellido:');
          if (!name) return;
          const created = await api('/api/customers', { method: 'POST', body: { name, documentNumber: v, documentType: 'DNI' } });
          setCustomer(created); toast('Cliente creado', 'success');
        } catch (e) { toast('Error: ' + (e.message || ''), 'error'); }
      };
      m.querySelector('#sena-find').addEventListener('click', doFind);
      m.querySelector('#sena-doc').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); doFind(); } });
      m.querySelector('[data-act="cancel"]').addEventListener('click', () => close(null));
      let busy = false;
      m.querySelector('[data-act="ok"]').addEventListener('click', async () => {
        if (busy) return;
        if (!customer) { toast('Elegí (o creá) un cliente por documento', 'warn'); return; }
        const amount = Number(m.querySelector('#sena-amt').value) || 0;
        if (amount <= 0) { toast('El monto debe ser mayor a 0', 'warn'); return; }
        const opt = sel.options[sel.selectedIndex];
        const note = m.querySelector('#sena-note').value.trim() || null;
        busy = true;
        try {
          const sena = await Senas.create({
            customerId: customer.id, amount, branchId: activeBranchId(),
            methodId: sel.value, methodName: opt.text, affectsCash: opt.dataset.cash === '1', note,
          });
          toast(`Seña #${sena.number} creada (${money(amount)})${opt.dataset.cash === '1' ? ' · entró a caja' : ''}`, 'success');
          close({ ...sena, customer });
        } catch (e) { busy = false; toast('No se pudo crear: ' + (e.message || ''), 'error'); }
      });
      setTimeout(() => m.querySelector('#sena-doc').focus(), 50);
    },
  });
}

// Elegir CÓMO se le devuelve plata de una seña al cliente. Si es efectivo sale de la caja;
// con cualquier otro medio no impacta en la caja. Devuelve { methodId, methodName,
// affectsCash, branchId } o null si se canceló.
export async function openRefundModal({ title = 'Devolver seña', message = '', amount = 0, defaultMethodId = null, confirmLabel = 'Confirmar devolución' } = {}) {
  const methods = await loadPaymentMethods();
  const def = methods.find((m) => m.id === defaultMethodId) ? defaultMethodId : methods[0]?.id;
  return openModal({
    title,
    size: 'sm',
    bodyHTML: `
      ${message ? `<p class="text-sm text-[#241a0d] mb-3">${message}</p>` : ''}
      <div class="bg-[#fff8f4] rounded-xl p-3 flex justify-between items-center mb-3">
        <span class="font-black text-[#241a0d]">A DEVOLVER</span>
        <span class="font-black text-2xl text-[#d82f1e]">${money(amount)}</span>
      </div>
      <label class="block text-xs font-bold text-[#7d6c5c] uppercase mb-1">¿Cómo se devuelve?</label>
      <select id="rf-method" class="ing-input w-full">${methods.map((m) => `<option value="${esc(m.id)}" data-cash="${m.affects_cash ? 1 : 0}" ${m.id === def ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
      <div id="rf-hint" class="text-xs mt-2 font-bold"></div>`,
    footerHTML: `<button class="ing-btn-secondary" data-act="cancel">Cancelar</button><button class="ing-btn-primary" data-act="ok">${esc(confirmLabel)}</button>`,
    onOpen: (m, close) => {
      const sel = m.querySelector('#rf-method');
      const hint = m.querySelector('#rf-hint');
      const draw = () => {
        const cash = sel.options[sel.selectedIndex]?.dataset.cash === '1';
        hint.className = 'text-xs mt-2 font-bold ' + (cash ? 'text-[#d82f1e]' : 'text-[#7d6c5c]');
        hint.textContent = cash ? `Sale ${money(amount)} de la caja de esta sucursal.` : 'No impacta en la caja.';
      };
      sel.addEventListener('change', draw); draw();
      m.querySelector('[data-act="cancel"]').addEventListener('click', () => close(null));
      m.querySelector('[data-act="ok"]').addEventListener('click', () => {
        const opt = sel.options[sel.selectedIndex];
        close({ methodId: sel.value, methodName: opt.text, affectsCash: opt.dataset.cash === '1', branchId: activeBranchId() });
      });
    },
  });
}

// Comprobante imprimible de una seña.
export function printSena(sena, branchName = '') {
  const c = sena.customer || {};
  printHTML({
    title: `Seña #${sena.number}`,
    bodyHTML: `
      <div style="font-family:system-ui,Arial,sans-serif;max-width:360px;margin:0 auto">
        <h1 style="margin:0;font-size:22px">Ingenium</h1>
        <div style="color:#666;font-size:12px;margin-bottom:12px">Comprobante de seña${branchName ? ' · ' + esc(branchName) : ''}</div>
        <div style="border:2px solid #222;border-radius:10px;padding:12px;margin-bottom:12px">
          <div style="font-size:13px;color:#666">SEÑA N°</div>
          <div style="font-size:28px;font-weight:900">#${esc(sena.number)}</div>
          <div style="font-size:13px;color:#666;margin-top:8px">MONTO</div>
          <div style="font-size:28px;font-weight:900">${money(sena.amount)}</div>
        </div>
        <table style="width:100%;font-size:13px;border-collapse:collapse">
          <tr><td style="padding:3px 0;color:#666">Fecha</td><td style="text-align:right">${esc(fmtDateTime(sena.createdAt))}</td></tr>
          <tr><td style="padding:3px 0;color:#666">Cliente</td><td style="text-align:right">${esc(c.name || '')}</td></tr>
          ${c.documentNumber ? `<tr><td style="padding:3px 0;color:#666">Documento</td><td style="text-align:right">${esc(c.documentNumber)}</td></tr>` : ''}
          <tr><td style="padding:3px 0;color:#666">Medio de pago</td><td style="text-align:right">${esc(sena.methodName || '')}</td></tr>
          ${sena.note ? `<tr><td style="padding:3px 0;color:#666">Reserva</td><td style="text-align:right">${esc(sena.note)}</td></tr>` : ''}
        </table>
        <p style="font-size:11px;color:#666;margin-top:14px">Presentá este comprobante o tu documento para usar la seña en tu compra.</p>
      </div>`,
  });
}
