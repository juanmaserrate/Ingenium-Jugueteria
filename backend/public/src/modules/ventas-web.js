// M\u00f3dulo Ventas Web: \u00f3rdenes de Tienda Nube pendientes de asignaci\u00f3n de sucursal.

import { api, ApiError } from '../core/api.js';
import { toast } from '../core/notifications.js';

export async function mount(el) {
  el.innerHTML = renderShell();
  const listEl = el.querySelector('#orders-list');

  async function refresh() {
    try {
      const [orders, branches] = await Promise.all([
        api('/api/tn-orders?status=pending'),
        api('/auth/branches'),
      ]);
      if (orders.length === 0) {
        listEl.innerHTML = `
          <div class="text-center py-12 text-[#7d6c5c]">
            <span class="material-symbols-outlined text-5xl">inbox</span>
            <p class="mt-2">No hay ventas web pendientes de asignaci\u00f3n</p>
          </div>`;
        return;
      }
      listEl.innerHTML = orders.map((o) => renderOrder(o, branches)).join('');
      listEl.querySelectorAll('.btn-assign').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          const id = btn.dataset.id;
          const branchId = el.querySelector(`#branch-${id}`).value;
          await assign(id, branchId);
        });
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 0) {
        listEl.innerHTML = '<div class="text-center py-8 text-red-700">Backend offline</div>';
      } else {
        toast(err.message, 'error');
      }
    }
  }

  async function assign(id, branchId, allowNegative = false) {
    try {
      const res = await api(`/api/tn-orders/${id}/assign`, {
        method: 'POST',
        body: { branchId, allowNegative },
      });
      if (res.error === 'unmapped_items') {
        toast(`${res.missing.length} items sin mapping a productos locales. Revis\u00e1 los productos pendientes.`, 'warning');
        return;
      }
      toast(`Venta asignada a ${branchId}`, 'success');
      refresh();
    } catch (err) {
      if (err.code === 'STOCK_INSUFFICIENT') {
        if (confirm('Stock insuficiente en esa sucursal. \u00bfConfirmar venta igual (stock negativo)?')) {
          return assign(id, branchId, true);
        }
      } else {
        toast(err.message, 'error');
      }
    }
  }

  await refresh();
  const interval = setInterval(refresh, 30_000);
  return () => clearInterval(interval);
}

function renderOrder(o, branches) {
  const items = (o.items || [])
    .map(
      (i) => `
    <tr class="border-b border-[#fff1e6]">
      <td class="py-1 px-2 text-sm">${i.productName}${i.variantName ? ' / ' + i.variantName : ''}</td>
      <td class="py-1 px-2 text-sm text-center">${i.qty}</td>
      <td class="py-1 px-2 text-sm text-right">$${Number(i.unitPrice).toFixed(2)}</td>
    </tr>
  `,
    )
    .join('');

  const branchOpts = branches.map((b) => `<option value="${b.id}">${b.name}</option>`).join('');

  return `
    <div class="bg-white rounded-2xl shadow-sm border border-[#fff1e6] p-5 space-y-3">
      <header class="flex items-center justify-between">
        <div>
          <p class="font-bold text-lg">Orden TN #${o.number ?? o.tnOrderId}</p>
          <p class="text-sm text-[#7d6c5c]">${o.customerName} \u00b7 ${o.customerEmail ?? 'sin email'}</p>
          <p class="text-xs text-[#7d6c5c]">Recibida: ${new Date(o.receivedAt).toLocaleString('es-AR')}</p>
        </div>
        <div class="text-right">
          <p class="text-2xl font-black">$${Number(o.total).toFixed(2)}</p>
          <p class="text-xs text-[#7d6c5c]">${o.currency}</p>
        </div>
      </header>
      <table class="w-full">
        <thead>
          <tr class="text-xs text-[#7d6c5c] uppercase text-left">
            <th class="py-1 px-2">Producto</th>
            <th class="py-1 px-2 text-center">Cant</th>
            <th class="py-1 px-2 text-right">Precio</th>
          </tr>
        </thead>
        <tbody>${items}</tbody>
      </table>
      <div class="flex items-center gap-3 pt-3 border-t border-[#fff1e6]">
        <label class="text-sm font-bold">Asignar a sucursal:</label>
        <select id="branch-${o.id}" class="px-3 py-2 rounded-xl border border-[#fff1e6] flex-1">${branchOpts}</select>
        <button data-id="${o.id}" class="btn-assign px-4 py-2 bg-[#d82f1e] text-white rounded-xl font-bold">Confirmar</button>
      </div>
    </div>
  `;
}

function renderShell() {
  return `
    <div class="max-w-5xl mx-auto space-y-6">
      <header>
        <h1 class="text-3xl font-black text-[#241a0d]">Ventas Web</h1>
        <p class="text-[#7d6c5c] text-sm">\u00d3rdenes pagadas de Tienda Nube esperando que elijas a qu\u00e9 sucursal imputarlas.</p>
      </header>
      <div id="orders-list" class="space-y-4">
        <div class="text-center py-8 text-[#7d6c5c]">Cargando...</div>
      </div>
    </div>
  `;
}
