// M\u00f3dulo Productos TN Pendientes: productos creados en TN que esperan aprobaci\u00f3n
// + asignaci\u00f3n de stock por sucursal.

import { api, ApiError } from '../core/api.js';
import { toast } from '../core/notifications.js';

export async function mount(el) {
  el.innerHTML = renderShell();
  const listEl = el.querySelector('#pending-list');

  async function refresh() {
    try {
      const [pending, branches] = await Promise.all([
        api('/api/tn-products-pending?status=pending'),
        api('/auth/branches'),
      ]);
      if (pending.length === 0) {
        listEl.innerHTML = `
          <div class="text-center py-12 text-[#7d6c5c]">
            <span class="material-symbols-outlined text-5xl">inbox</span>
            <p class="mt-2">No hay productos pendientes</p>
          </div>`;
        return;
      }
      listEl.innerHTML = pending.map((p) => renderPending(p, branches)).join('');

      listEl.querySelectorAll('.btn-approve').forEach((btn) => {
        btn.addEventListener('click', () => approve(btn.dataset.id, branches));
      });
      listEl.querySelectorAll('.btn-reject').forEach((btn) => {
        btn.addEventListener('click', () => reject(btn.dataset.id));
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 0) {
        listEl.innerHTML = '<div class="text-center py-8 text-red-700">Backend offline</div>';
      } else {
        toast(err.message, 'error');
      }
    }
  }

  async function approve(id, branches) {
    const card = el.querySelector(`[data-pending-id="${id}"]`);
    const stockAssignments = [];
    const costByVariant = {};
    card.querySelectorAll('.variant-row').forEach((row) => {
      const tnVariantId = row.dataset.tnVariantId;
      const costInput = row.querySelector('.cost-input');
      if (costInput && costInput.value) costByVariant[tnVariantId] = parseFloat(costInput.value);
      branches.forEach((b) => {
        const qtyInput = row.querySelector(`.qty-input[data-branch="${b.id}"]`);
        const qty = parseInt(qtyInput?.value ?? '0', 10);
        stockAssignments.push({ tnVariantId, branchId: b.id, qty: isNaN(qty) ? 0 : qty });
      });
    });
    try {
      await api(`/api/tn-products-pending/${id}/approve`, {
        method: 'POST',
        body: { stockAssignments, costByVariant },
      });
      toast('Producto aprobado e importado', 'success');
      refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function reject(id) {
    if (!confirm('\u00bfRechazar este producto? No se importar\u00e1 a Ingenium.')) return;
    try {
      await api(`/api/tn-products-pending/${id}/reject`, { method: 'POST' });
      toast('Producto rechazado', 'success');
      refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  await refresh();
}

function renderPending(p, branches) {
  const tn = p.payload;
  const variants = tn.variants ?? [];
  const attrs = (tn.attributes ?? []).map((a) => a.es).filter(Boolean);

  const variantRows = variants
    .map((v) => {
      const values = (v.values ?? []).map((x) => x.es ?? x).join(' / ') || 'default';
      const branchInputs = branches
        .map(
          (b) => `
        <div class="flex flex-col items-center">
          <span class="text-[10px] text-[#7d6c5c]">${b.name}</span>
          <input type="number" min="0" value="0" data-branch="${b.id}"
            class="qty-input w-16 px-2 py-1 rounded border border-[#fff1e6] text-center text-sm" />
        </div>
      `,
        )
        .join('');
      return `
      <tr class="variant-row border-b border-[#fff1e6]" data-tn-variant-id="${v.id}">
        <td class="py-2 px-2 text-sm">${values}</td>
        <td class="py-2 px-2 text-sm font-mono">${v.sku ?? '-'}</td>
        <td class="py-2 px-2 text-sm text-right">$${v.price}</td>
        <td class="py-2 px-2">
          <input type="number" min="0" step="0.01" placeholder="Costo"
            class="cost-input w-20 px-2 py-1 rounded border border-[#fff1e6] text-sm" />
        </td>
        <td class="py-2 px-2">
          <div class="flex gap-2 justify-end">${branchInputs}</div>
        </td>
      </tr>
    `;
    })
    .join('');

  return `
    <div data-pending-id="${p.id}" class="bg-white rounded-2xl shadow-sm border border-[#fff1e6] p-5 space-y-4">
      <header class="flex items-center justify-between">
        <div>
          <p class="font-bold text-lg">${tn.name?.es ?? 'Sin nombre'}</p>
          <p class="text-xs text-[#7d6c5c]">TN ID: ${tn.id} \u00b7 ${attrs.length > 0 ? 'Atributos: ' + attrs.join(', ') : 'Sin atributos'}</p>
          ${tn.description?.es ? `<p class="text-sm text-[#7d6c5c] mt-1">${tn.description.es}</p>` : ''}
        </div>
      </header>
      <table class="w-full">
        <thead>
          <tr class="text-xs text-[#7d6c5c] uppercase text-left">
            <th class="py-2 px-2">Variante</th>
            <th class="py-2 px-2">SKU</th>
            <th class="py-2 px-2 text-right">Precio</th>
            <th class="py-2 px-2">Costo</th>
            <th class="py-2 px-2 text-right">Stock inicial</th>
          </tr>
        </thead>
        <tbody>${variantRows}</tbody>
      </table>
      <div class="flex justify-end gap-2 pt-3 border-t border-[#fff1e6]">
        <button data-id="${p.id}" class="btn-reject px-4 py-2 bg-gray-200 text-[#241a0d] rounded-xl font-bold">Rechazar</button>
        <button data-id="${p.id}" class="btn-approve px-4 py-2 bg-[#d82f1e] text-white rounded-xl font-bold">Aprobar e importar</button>
      </div>
    </div>
  `;
}

function renderShell() {
  return `
    <div class="max-w-6xl mx-auto space-y-6">
      <header>
        <h1 class="text-3xl font-black text-[#241a0d]">Productos de Tienda Nube</h1>
        <p class="text-[#7d6c5c] text-sm">Productos creados en TN que esperan revisi\u00f3n y asignaci\u00f3n de stock inicial.</p>
      </header>
      <div id="pending-list" class="space-y-4">
        <div class="text-center py-8 text-[#7d6c5c]">Cargando...</div>
      </div>
    </div>
  `;
}
