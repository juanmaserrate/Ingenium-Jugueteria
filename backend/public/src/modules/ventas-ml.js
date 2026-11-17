// Módulo Ventas Mercado Libre: órdenes pagadas de ML pendientes de asignar a una sucursal.
// Mismo circuito que "Ventas Web" (Tienda Nube): al confirmar se registra la venta con la
// comisión real de Mercado Pago y se descuenta el stock de la sucursal elegida.
// Mientras está pendiente, esas unidades ya están descontadas del stock publicado (ML y TN).

import { api, ApiError } from '../core/api.js';
import { toast } from '../core/notifications.js';
import { activeBranchId } from '../core/auth.js';

// Nombres/títulos vienen de Mercado Libre (comprador externo): tratarlos como no confiables.
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const money = (n) => '$' + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export async function mount(el) {
  el.innerHTML = renderShell();
  const listEl = el.querySelector('#orders-list');

  async function refresh() {
    try {
      const [orders, branches] = await Promise.all([
        api('/api/ml-orders?status=pending'),
        api('/auth/branches'),
      ]);
      if (!orders || orders.length === 0) {
        listEl.innerHTML = `
          <div class="text-center py-12 text-[#7d6c5c]">
            <span class="material-symbols-outlined text-5xl">inbox</span>
            <p class="mt-2">No hay ventas de Mercado Libre pendientes de asignación</p>
          </div>`;
        return;
      }
      listEl.innerHTML = orders.map((o) => renderOrder(o, branches)).join('');
      listEl.querySelectorAll('.btn-assign').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.id;
          const branchId = el.querySelector(`#branch-${id}`).value;
          btn.disabled = true;
          await assign(id, branchId);
          btn.disabled = false;
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
      const res = await api(`/api/ml-orders/${id}/assign`, { method: 'POST', body: { branchId, allowNegative } });
      if (res && res.error === 'unmapped_items') {
        toast(`${res.missing.length} ítem(s) de esta venta no están vinculados a un producto. Vinculá la publicación desde Inventario → Sincronizar ML y reintentá.`, 'warning');
        return;
      }
      toast('Venta de Mercado Libre registrada y stock descontado', 'success');
      refresh();
    } catch (err) {
      if (err.code === 'STOCK_INSUFFICIENT') {
        if (confirm('Stock insuficiente en esa sucursal. ¿Confirmar venta igual (stock negativo)?')) {
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
  const items = (o.items || []).map((i) => `
    <tr class="border-b border-[#fff1e6]">
      <td class="py-1 px-2 text-sm">${esc(i.title || i.mlItemId)}</td>
      <td class="py-1 px-2 text-sm text-center">${Number(i.qty)}</td>
      <td class="py-1 px-2 text-sm text-right">${money(i.unitPrice)}</td>
    </tr>`).join('');

  // Por defecto, la sucursal activa (donde está el operador).
  const active = activeBranchId();
  const branchOpts = branches.map((b) => `<option value="${esc(b.id)}" ${b.id === active ? 'selected' : ''}>${esc(b.name)}</option>`).join('');

  return `
    <div class="bg-white rounded-2xl shadow-sm border border-[#fff1e6] p-5 space-y-3">
      <header class="flex items-center justify-between">
        <div>
          <p class="font-bold text-lg">Orden ML #${esc(o.number ?? o.mlOrderId)}</p>
          <p class="text-sm text-[#7d6c5c]">${esc(o.customerName)}</p>
          <p class="text-xs text-[#7d6c5c]">Recibida: ${new Date(o.receivedAt).toLocaleString('es-AR')}</p>
        </div>
        <div class="text-right">
          <p class="text-2xl font-black">${money(o.total)}</p>
          <p class="text-xs text-[#7d6c5c]">${esc(o.currency)}</p>
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
        <select id="branch-${esc(o.id)}" class="px-3 py-2 rounded-xl border border-[#fff1e6] flex-1">${branchOpts}</select>
        <button data-id="${esc(o.id)}" class="btn-assign px-4 py-2 bg-[#d82f1e] text-white rounded-xl font-bold">Confirmar</button>
      </div>
    </div>`;
}

function renderShell() {
  return `
    <div class="max-w-5xl mx-auto space-y-6">
      <header>
        <h1 class="text-3xl font-black text-[#241a0d]">Ventas Mercado Libre</h1>
        <p class="text-[#7d6c5c] text-sm">Órdenes pagadas de Mercado Libre esperando que elijas a qué sucursal imputarlas. Al confirmar se registra la venta con la comisión real y se descuenta el stock de esa sucursal.</p>
      </header>
      <div id="orders-list" class="space-y-4">
        <div class="text-center py-8 text-[#7d6c5c]">Cargando...</div>
      </div>
    </div>`;
}
