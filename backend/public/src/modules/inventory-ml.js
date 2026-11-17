// Mercado Libre desde Inventario: publicar la selección, ver/gestionar el vínculo de un
// producto y sincronizar las publicaciones que ya existen en ML con el inventario.
// Toda acción que crea/cierra publicaciones reales pide confirmación antes.

import * as P from '../repos/products.js';
import { openModal, confirmModal } from '../components/modal.js';
import { toast } from '../core/notifications.js';
import { money } from '../core/format.js';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const mlUrl = (id) => `https://articulo.mercadolibre.com.ar/${String(id || '').replace(/^([A-Z]{3})(\d+)$/, '$1-$2')}`;
const variantLabel = (v) => {
  const vals = Object.values(v?.attributes || {}).map((x) => String(x ?? '').trim()).filter(Boolean);
  if (vals.length) return vals.join(' / ');
  return v?.name && v.name !== 'default' ? v.name : '';
};
const errText = (err) => {
  const b = err?.body || {};
  if (b.error === 'missing_attributes' && Array.isArray(b.missing)) {
    return 'Mercado Libre pide completar: ' + b.missing.map((m) => m.name || m.id).join(', ') + '. Publicalo desde "Editar" el producto.';
  }
  const det = b.details ? (typeof b.details === 'string' ? b.details : (b.details.message || JSON.stringify(b.details))) : '';
  return b.message || det || err?.message || 'Error';
};

const PKG_KEY = 'ml_pkg_default';
function pkgDefaults() {
  const base = { weight: 500, height: 15, width: 20, length: 20, iva: '21' };
  try { return { ...base, ...(JSON.parse(localStorage.getItem(PKG_KEY) || '{}')) }; } catch { return base; }
}

// ---------------------------------------------------------------------------
// 1) Publicar la selección
// ---------------------------------------------------------------------------
export function openMlPublishModal(products) {
  const todo = products.filter((p) => !p.linked_ml && Number(p.price) > 0);
  const already = products.filter((p) => p.linked_ml);
  const noPrice = products.filter((p) => !p.linked_ml && !(Number(p.price) > 0));
  const d = pkgDefaults();
  let changed = false;
  let running = false;
  let stop = false;

  return openModal({
    title: 'Publicar en Mercado Libre',
    size: 'lg',
    closeOnBackdrop: false,
    bodyHTML: `
      <div class="space-y-4">
        <div class="flex flex-wrap gap-2 text-sm">
          <span class="px-3 py-1 rounded-full bg-green-100 text-green-800 font-bold">${todo.length} para publicar</span>
          ${already.length ? `<span class="px-3 py-1 rounded-full bg-gray-100 text-gray-600 font-bold">${already.length} ya vinculado(s) — se saltean</span>` : ''}
          ${noPrice.length ? `<span class="px-3 py-1 rounded-full bg-amber-100 text-amber-800 font-bold">${noPrice.length} sin precio — se saltean</span>` : ''}
        </div>
        <p class="text-xs text-[#7d6c5c]">Se crea una publicación real por producto (una por variante si tiene colores/talles) con el <b>precio y el stock del sistema</b> y la foto de Tienda Nube. Quedan vinculadas: cada venta en el local, Tienda Nube o Mercado Libre descuenta en los tres.</p>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3 p-3 bg-[#fff8f4] rounded-xl border border-[#fff1e6]">
          <label class="block col-span-2"><span class="text-[10px] font-black text-[#7d6c5c] uppercase">Tipo de publicación</span>
            <select id="mlp-listing" class="ing-input mt-1"><option value="gold_special" selected>Clásica (sin costo)</option><option value="gold_pro">Premium</option><option value="free">Gratuita</option></select></label>
          <label class="block"><span class="text-[10px] font-black text-[#7d6c5c] uppercase">Condición</span>
            <select id="mlp-condition" class="ing-input mt-1"><option value="new">Nuevo</option><option value="used">Usado</option></select></label>
          <label class="block"><span class="text-[10px] font-black text-[#7d6c5c] uppercase">IVA</span>
            <select id="mlp-iva" class="ing-input mt-1"><option value="21">21%</option><option value="10.5">10,5%</option><option value="0">0%</option></select></label>
          <label class="block"><span class="text-[10px] font-black text-[#7d6c5c] uppercase">Peso paquete (g)</span><input id="mlp-weight" type="number" min="1" class="ing-input mt-1" value="${esc(d.weight)}" /></label>
          <label class="block"><span class="text-[10px] font-black text-[#7d6c5c] uppercase">Alto (cm)</span><input id="mlp-height" type="number" min="1" class="ing-input mt-1" value="${esc(d.height)}" /></label>
          <label class="block"><span class="text-[10px] font-black text-[#7d6c5c] uppercase">Ancho (cm)</span><input id="mlp-width" type="number" min="1" class="ing-input mt-1" value="${esc(d.width)}" /></label>
          <label class="block"><span class="text-[10px] font-black text-[#7d6c5c] uppercase">Largo (cm)</span><input id="mlp-length" type="number" min="1" class="ing-input mt-1" value="${esc(d.length)}" /></label>
        </div>
        <div id="mlp-progress" class="hidden">
          <div class="h-2 bg-[#fff1e6] rounded-full overflow-hidden"><div id="mlp-bar" class="h-2 bg-[#d82f1e] rounded-full transition-all" style="width:0%"></div></div>
          <div id="mlp-count" class="text-xs text-[#7d6c5c] mt-1"></div>
        </div>
        <div id="mlp-log" class="space-y-1 text-sm max-h-72 overflow-auto"></div>
      </div>`,
    footerHTML: `
      <button class="ing-btn-secondary" data-act="close">Cerrar</button>
      <button class="ing-btn-primary" data-act="run" ${todo.length ? '' : 'disabled'}>Publicar ${todo.length} producto${todo.length === 1 ? '' : 's'}</button>`,
    onOpen: (el, close) => {
      el.querySelector('#mlp-iva').value = String(d.iva);
      const runBtn = el.querySelector('[data-act="run"]');
      const closeBtn = el.querySelector('[data-act="close"]');
      closeBtn.addEventListener('click', () => {
        if (running) { stop = true; closeBtn.textContent = 'Deteniendo…'; return; }
        close(changed);
      });
      runBtn.addEventListener('click', async () => {
        if (running || !todo.length) return;
        const ok = await confirmModal({
          title: 'Crear publicaciones reales',
          message: `Se van a crear publicaciones reales en tu cuenta de Mercado Libre para ${todo.length} producto${todo.length === 1 ? '' : 's'}. ¿Confirmás?`,
          confirmLabel: 'Sí, publicar',
        });
        if (!ok) return;
        const n = (sel) => Math.max(1, Math.round(Number(el.querySelector(sel)?.value) || 0));
        const weight = n('#mlp-weight'), height = n('#mlp-height'), width = n('#mlp-width'), length = n('#mlp-length');
        const iva = el.querySelector('#mlp-iva').value || '21';
        try { localStorage.setItem(PKG_KEY, JSON.stringify({ weight, height, width, length, iva })); } catch {}
        const opts = {
          listingTypeId: el.querySelector('#mlp-listing').value,
          condition: el.querySelector('#mlp-condition').value,
          attributes: [
            { id: 'SELLER_PACKAGE_WEIGHT', value_name: weight + ' g' },
            { id: 'SELLER_PACKAGE_HEIGHT', value_name: height + ' cm' },
            { id: 'SELLER_PACKAGE_WIDTH', value_name: width + ' cm' },
            { id: 'SELLER_PACKAGE_LENGTH', value_name: length + ' cm' },
            { id: 'VALUE_ADDED_TAX', value_name: iva + '%' },
          ],
        };

        running = true; stop = false;
        runBtn.disabled = true; runBtn.textContent = 'Publicando…';
        closeBtn.textContent = 'Detener';
        el.querySelector('#mlp-progress').classList.remove('hidden');
        const log = el.querySelector('#mlp-log');
        const bar = el.querySelector('#mlp-bar');
        const count = el.querySelector('#mlp-count');
        let ok2 = 0, fail = 0, done = 0;
        for (const p of todo) {
          if (stop) break;
          const line = document.createElement('div');
          line.className = 'flex gap-2 items-start';
          line.innerHTML = `<span>⏳</span><span>${esc(p.name)}…</span>`;
          log.prepend(line);
          try {
            const res = await P.publishMl(p.id, opts);
            changed = true; ok2++;
            const link = res?.permalink || (res?.itemId ? mlUrl(res.itemId) : '');
            const what = res?.alreadyLinked ? 'ya estaba publicado'
              : res?.mode === 'fanout' ? `publicado: ${res.count} publicaciones (una por variante)${res.failed?.length ? `, ${res.failed.length} variante(s) con error` : ''}`
              : 'publicado';
            line.innerHTML = `<span>✅</span><span><b>${esc(p.name)}</b> — ${what}${link ? ` · <a href="${esc(link)}" target="_blank" rel="noopener" class="underline text-[#d82f1e]">ver</a>` : ''}</span>`;
          } catch (err) {
            fail++;
            line.innerHTML = `<span>❌</span><span><b>${esc(p.name)}</b> — <span class="text-red-600">${esc(errText(err))}</span></span>`;
          }
          done++;
          bar.style.width = Math.round((done / todo.length) * 100) + '%';
          count.textContent = `${done} de ${todo.length} · ${ok2} publicados · ${fail} con error`;
        }
        running = false;
        closeBtn.textContent = 'Cerrar';
        runBtn.textContent = stop ? 'Detenido' : 'Terminado';
        toast(`Mercado Libre: ${ok2} publicado(s), ${fail} con error`, fail ? 'warn' : 'success');
      });
    },
  });
}

// ---------------------------------------------------------------------------
// 2) Despublicar la selección (cierra las publicaciones)
// ---------------------------------------------------------------------------
export async function bulkUnpublishMl(products) {
  const linked = products.filter((p) => p.linked_ml);
  if (!linked.length) { toast('Ninguno de los seleccionados está en Mercado Libre', 'info'); return false; }
  const ok = await confirmModal({
    title: 'Cerrar publicaciones',
    message: `Se van a CERRAR en Mercado Libre las publicaciones de ${linked.length} producto${linked.length === 1 ? '' : 's'}. ¿Confirmás?`,
    danger: true, confirmLabel: 'Sí, cerrar',
  });
  if (!ok) return false;
  let done = 0, fail = 0;
  for (const p of linked) {
    try { await P.unpublishMl(p.id); done++; } catch { fail++; }
  }
  toast(`Mercado Libre: ${done} cerrada(s)${fail ? `, ${fail} con error` : ''}`, fail ? 'warn' : 'success');
  return done > 0;
}

// ---------------------------------------------------------------------------
// 3) Botón ML de la fila: estado del vínculo / publicar / vincular a una existente
// ---------------------------------------------------------------------------
export async function openMlProductModal(p) {
  if (!p.linked_ml) {
    const variants = (p.variants || []);
    const varSel = variants.length > 1
      ? `<label class="block"><span class="text-[10px] font-black text-[#7d6c5c] uppercase">Variante</span>
           <select id="mll-variant" class="ing-input mt-1">${variants.map((v) => `<option value="${esc(v.id)}">${esc(variantLabel(v) || 'Principal')}</option>`).join('')}</select></label>`
      : '';
    const action = await openModal({
      title: `Mercado Libre · ${p.name}`,
      size: 'sm',
      bodyHTML: `
        <p class="text-sm text-[#7d6c5c] mb-3">Este producto todavía no está en Mercado Libre.</p>
        <div class="space-y-2">
          <button data-act="publish" class="w-full flex items-center gap-3 px-3 py-3 border border-[#e3ceba] rounded-xl hover:border-[#d82f1e] hover:bg-[#fff8f4] text-left">
            <span class="material-symbols-outlined text-[#d82f1e]">storefront</span>
            <span><span class="font-bold block text-sm">Publicar en Mercado Libre</span><span class="text-xs text-[#7d6c5c]">Crea la publicación con el precio y stock del sistema</span></span>
          </button>
          <div class="px-3 py-3 border border-[#e3ceba] rounded-xl space-y-2">
            <div class="flex items-center gap-3"><span class="material-symbols-outlined text-[#7d6c5c]">add_link</span>
              <span><span class="font-bold block text-sm">Ya está publicado: vincular</span><span class="text-xs text-[#7d6c5c]">Pegá el código de la publicación (MLA…)</span></span></div>
            ${varSel}
            <input id="mll-item" class="ing-input" placeholder="MLA123456789" />
            <input id="mll-variation" class="ing-input" placeholder="ID de variación (opcional)" />
            <button data-act="link" class="ing-btn-secondary w-full text-sm">Vincular</button>
          </div>
        </div>`,
      footerHTML: `<button class="ing-btn-secondary" data-act="cancel">Cancelar</button>`,
      onOpen: (el, close) => {
        el.querySelector('[data-act="publish"]').addEventListener('click', () => close('publish'));
        el.querySelector('[data-act="cancel"]').addEventListener('click', () => close(null));
        el.querySelector('[data-act="link"]').addEventListener('click', async () => {
          const mlItemId = el.querySelector('#mll-item').value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
          if (!/^[A-Z]{3}\d+$/.test(mlItemId)) { toast('Código de publicación inválido (ej: MLA123456789)', 'warn'); return; }
          const variantId = el.querySelector('#mll-variant')?.value || (variants.find((v) => v.is_default) || variants[0])?.id || p.variant_id;
          const mlVariationId = el.querySelector('#mll-variation').value.trim() || null;
          try {
            const res = await P.mlSyncApply([{ variantId, mlItemId, mlVariationId, productId: p.id }]);
            if (res?.errors?.length) { toast(res.errors[0].error, 'error'); return; }
            toast('Vinculado: el stock del sistema ya se envió a Mercado Libre', 'success');
            close('linked');
          } catch (err) { toast(errText(err), 'error'); }
        });
      },
    });
    if (action === 'publish') return !!(await openMlPublishModal([p]));
    return action === 'linked';
  }

  // Ya vinculado → estado en vivo.
  let changed = false;
  await openModal({
    title: `Mercado Libre · ${p.name}`,
    size: 'lg',
    bodyHTML: `<div id="mls-body" class="text-sm text-[#7d6c5c]">Consultando Mercado Libre…</div>`,
    footerHTML: `
      <button class="ing-btn-secondary" data-act="unlink" title="Deja la publicación en ML pero deja de sincronizar">Desvincular</button>
      <button class="ing-btn-secondary !text-red-600" data-act="unpublish">Cerrar publicación</button>
      <button class="ing-btn-secondary" data-act="push">Reenviar stock</button>
      <button class="ing-btn-primary" data-act="close">Listo</button>`,
    onOpen: (el, close) => {
      const body = el.querySelector('#mls-body');
      let items = [];
      const load = async () => {
        body.innerHTML = 'Consultando Mercado Libre…';
        try {
          const st = await P.mlStatus(p.id);
          items = st?.items || [];
          if (!items.length) { body.innerHTML = 'No hay publicaciones vinculadas.'; return; }
          body.innerHTML = `
            <table class="w-full text-sm">
              <thead><tr class="text-left text-[10px] text-[#7d6c5c] uppercase">
                <th class="py-2 px-2">Variante</th><th class="py-2 px-2">Publicación</th><th class="py-2 px-2">Estado en ML</th>
                <th class="py-2 px-2 text-right">Stock sistema</th><th class="py-2 px-2 text-right">Stock en ML</th><th class="py-2 px-2 text-right">Precio ML</th><th></th>
              </tr></thead>
              <tbody>${items.map((it) => {
                const same = it.mlQty != null && Number(it.mlQty) === Number(it.systemStock);
                const estado = it.mlError ? `<span class="text-red-600">${esc(it.mlError)}</span>`
                  : ({ active: 'Activa', paused: 'Pausada', closed: 'Cerrada', under_review: 'En revisión' }[it.mlStatus] || esc(it.mlStatus));
                return `<tr class="border-t border-[#fff1e6]">
                  <td class="py-1.5 px-2">${esc(it.variantName || 'Principal')}</td>
                  <td class="py-1.5 px-2"><a href="${esc(it.permalink || mlUrl(it.mlItemId))}" target="_blank" rel="noopener" class="underline text-[#d82f1e]">${esc(it.mlItemId)}</a></td>
                  <td class="py-1.5 px-2">${estado}</td>
                  <td class="py-1.5 px-2 text-right font-bold">${it.systemStock}</td>
                  <td class="py-1.5 px-2 text-right font-bold">${it.mlQty ?? '-'}</td>
                  <td class="py-1.5 px-2 text-right">${it.mlPrice != null ? money(it.mlPrice) : '-'}</td>
                  <td class="py-1.5 px-2 text-right">${it.mlError ? '' : same ? '<span class="text-green-700 font-bold">✓ igual</span>' : '<span class="text-amber-700 font-bold">≠ distinto</span>'}</td>
                </tr>`;
              }).join('')}</tbody>
            </table>
            <p class="text-xs text-[#7d6c5c] mt-3">El stock del sistema manda. Si ves "distinto", esperá unos segundos (la cola de sincronización) o tocá <b>Reenviar stock</b>.</p>`;
        } catch (err) { body.innerHTML = `<span class="text-red-600">${esc(errText(err))}</span>`; }
      };
      el.querySelector('[data-act="close"]').addEventListener('click', () => close(null));
      el.querySelector('[data-act="push"]').addEventListener('click', async () => {
        if (!items.length) return;
        try {
          await P.mlSyncApply(items.map((it) => ({ variantId: it.variantId, mlItemId: it.mlItemId, mlVariationId: it.mlVariationId, productId: p.id })));
          toast('Stock reenviado a Mercado Libre', 'success');
          setTimeout(load, 4000);
        } catch (err) { toast(errText(err), 'error'); }
      });
      el.querySelector('[data-act="unlink"]').addEventListener('click', async () => {
        const ok = await confirmModal({ title: 'Desvincular', message: `¿Desvincular "${p.name}" de Mercado Libre? La publicación sigue activa en ML pero deja de sincronizar el stock.`, danger: true, confirmLabel: 'Desvincular' });
        if (!ok) return;
        try { await P.unlinkMl(p.id); changed = true; toast('Desvinculado de Mercado Libre', 'success'); close(null); }
        catch (err) { toast(errText(err), 'error'); }
      });
      el.querySelector('[data-act="unpublish"]').addEventListener('click', async () => {
        const ok = await confirmModal({ title: 'Cerrar publicación', message: `¿CERRAR la publicación de "${p.name}" en Mercado Libre? Deja de estar a la venta en ML.`, danger: true, confirmLabel: 'Sí, cerrar' });
        if (!ok) return;
        try { await P.unpublishMl(p.id); changed = true; toast('Publicación cerrada en Mercado Libre', 'success'); close(null); }
        catch (err) { toast(errText(err), 'error'); }
      });
      load();
    },
  });
  return changed;
}

// ---------------------------------------------------------------------------
// 4) Sincronizar lo que ya está publicado en ML con el inventario
// ---------------------------------------------------------------------------
export function openMlSyncModal() {
  let changed = false;
  return openModal({
    title: 'Sincronizar con Mercado Libre',
    size: 'xl',
    closeOnBackdrop: false,
    bodyHTML: `<div id="mlx-body" class="text-sm text-[#7d6c5c] py-8 text-center">Leyendo tus publicaciones de Mercado Libre… (puede tardar unos segundos)</div>`,
    footerHTML: `
      <span id="mlx-foot" class="text-xs text-[#7d6c5c] mr-auto"></span>
      <button class="ing-btn-secondary" data-act="close">Cerrar</button>
      <button class="ing-btn-primary" data-act="apply" disabled>Vincular seleccionadas</button>`,
    onOpen: async (el, close) => {
      const body = el.querySelector('#mlx-body');
      const applyBtn = el.querySelector('[data-act="apply"]');
      const foot = el.querySelector('#mlx-foot');
      el.querySelector('[data-act="close"]').addEventListener('click', () => close(changed));

      let rows = [];
      let products = [];
      try {
        const [plan, list] = await Promise.all([P.mlSyncPlan(), P.list()]);
        products = list || [];
        if (!plan?.available) { body.innerHTML = '<span class="text-red-600">Mercado Libre no está conectado.</span>'; return; }
        rows = (plan.rows || []).map((r, i) => ({ ...r, _i: i, _sel: r.state === 'match' }));
        foot.textContent = `${plan.scanned} publicaciones vigentes leídas`;
      } catch (err) { body.innerHTML = `<span class="text-red-600">${esc(errText(err))}</span>`; return; }

      const prodById = new Map(products.map((p) => [p.id, p]));
      const pubCell = (r) => `<a href="${esc(r.permalink || mlUrl(r.mlItemId))}" target="_blank" rel="noopener" class="underline decoration-dotted">${esc(r.title)}</a>${r.variationLabel ? ` <span class="text-[11px] px-1.5 py-0.5 rounded bg-[#fff1e6]">${esc(r.variationLabel)}</span>` : ''}
        <div class="text-[11px] text-[#7d6c5c]">${esc(r.mlItemId)}${r.mlStatus === 'paused' ? ' · pausada' : ''}</div>`;

      const render = () => {
        const match = rows.filter((r) => r.state === 'match');
        const un = rows.filter((r) => r.state === 'unmatched');
        const linked = rows.filter((r) => r.state === 'linked');
        const selCount = match.filter((r) => r._sel).length;
        applyBtn.disabled = selCount === 0;
        applyBtn.textContent = `Vincular seleccionadas (${selCount})`;

        const matchRows = match.map((r) => {
          const warn = Number(r.systemStock) === 0 && Number(r.mlQty) > 0;
          return `<tr class="border-t border-[#fff1e6]">
            <td class="py-1.5 px-2"><input type="checkbox" data-sel="${r._i}" ${r._sel ? 'checked' : ''} class="rounded text-[#d82f1e] focus:ring-[#d82f1e]" /></td>
            <td class="py-1.5 px-2">${pubCell(r)}</td>
            <td class="py-1.5 px-2"><b>${esc(r.productName || '')}</b>${r.variantName ? ` <span class="text-[11px] px-1.5 py-0.5 rounded bg-[#fff1e6]">${esc(r.variantName)}</span>` : ''}
              ${r._manual ? ' <span class="text-[11px] text-[#7d6c5c]">(elegido a mano)</span>' : ''}</td>
            <td class="py-1.5 px-2"><span class="px-2 py-0.5 rounded-full text-[11px] font-bold ${r.by === 'sku' ? 'bg-green-100 text-green-800' : 'bg-blue-100 text-blue-800'}">${r._manual ? 'manual' : r.by === 'sku' ? 'por código' : 'por título'}</span></td>
            <td class="py-1.5 px-2 text-right font-bold">${r.systemStock ?? 0}</td>
            <td class="py-1.5 px-2 text-right">${r.mlQty}${warn ? ' <span class="text-[11px] text-amber-700 block">quedará en 0 (pausada)</span>' : ''}</td>
          </tr>`;
        }).join('');

        const unRows = un.map((r) => `<tr class="border-t border-[#fff1e6]">
            <td class="py-1.5 px-2">${pubCell(r)}${r.note ? `<div class="text-[11px] text-amber-700">${esc(r.note)}</div>` : ''}</td>
            <td class="py-1.5 px-2 text-right">${r.mlQty}</td>
            <td class="py-1.5 px-2 w-[46%]">
              <div class="relative">
                <input data-pick="${r._i}" class="ing-input !py-1.5 text-sm" placeholder="Buscar producto del inventario…" value="${esc(r.suggestedProductId ? (prodById.get(r.suggestedProductId)?.name || '') : '')}" autocomplete="off" />
                <div data-menu="${r._i}" class="hidden absolute z-20 left-0 right-0 mt-1 bg-white border border-[#e3ceba] rounded-xl shadow-lg max-h-56 overflow-auto"></div>
              </div>
            </td>
          </tr>`).join('');

        body.className = 'text-sm';
        body.innerHTML = `
          <div class="flex flex-wrap gap-2 mb-3">
            <span class="px-3 py-1 rounded-full bg-green-100 text-green-800 font-bold">${match.length} para vincular</span>
            <span class="px-3 py-1 rounded-full bg-amber-100 text-amber-800 font-bold">${un.length} sin coincidencia</span>
            <span class="px-3 py-1 rounded-full bg-gray-100 text-gray-600 font-bold">${linked.length} ya vinculadas</span>
          </div>
          <p class="text-xs text-[#7d6c5c] mb-3">Al vincular, <b>el stock del sistema pisa el de Mercado Libre</b> y desde ahí quedan iguales. El precio de la publicación no se toca.</p>

          ${match.length ? `
          <h3 class="font-bold text-[#241a0d] mb-1">Coincidencias encontradas</h3>
          <div class="overflow-auto max-h-72 border border-[#fff1e6] rounded-xl mb-4">
            <table class="w-full text-sm">
              <thead class="sticky top-0 bg-white"><tr class="text-left text-[10px] text-[#7d6c5c] uppercase">
                <th class="py-2 px-2"><input type="checkbox" id="mlx-all" ${match.every((r) => r._sel) ? 'checked' : ''} class="rounded text-[#d82f1e] focus:ring-[#d82f1e]" /></th>
                <th class="py-2 px-2">Publicación en ML</th><th class="py-2 px-2">Producto del inventario</th><th class="py-2 px-2">Coincide</th>
                <th class="py-2 px-2 text-right">Stock sistema</th><th class="py-2 px-2 text-right">Stock ML</th>
              </tr></thead>
              <tbody>${matchRows}</tbody>
            </table>
          </div>` : ''}

          ${un.length ? `
          <h3 class="font-bold text-[#241a0d] mb-1">Sin coincidencia — elegí el producto a mano</h3>
          <div class="overflow-auto max-h-72 border border-[#fff1e6] rounded-xl">
            <table class="w-full text-sm">
              <thead class="sticky top-0 bg-white"><tr class="text-left text-[10px] text-[#7d6c5c] uppercase">
                <th class="py-2 px-2">Publicación en ML</th><th class="py-2 px-2 text-right">Stock ML</th><th class="py-2 px-2">Producto del inventario</th>
              </tr></thead>
              <tbody>${unRows}</tbody>
            </table>
          </div>` : ''}

          ${!match.length && !un.length ? '<div class="py-8 text-center text-[#7d6c5c]">Todo lo que tenés publicado en Mercado Libre ya está vinculado. ✓</div>' : ''}`;

        body.querySelectorAll('[data-sel]').forEach((cb) => cb.addEventListener('change', () => {
          rows[Number(cb.dataset.sel)]._sel = cb.checked;
          const n = rows.filter((r) => r.state === 'match' && r._sel).length;
          applyBtn.disabled = n === 0; applyBtn.textContent = `Vincular seleccionadas (${n})`;
        }));
        body.querySelector('#mlx-all')?.addEventListener('change', (e) => {
          rows.forEach((r) => { if (r.state === 'match') r._sel = e.target.checked; });
          render();
        });

        // Buscador de producto para las filas sin coincidencia.
        const taken = new Set(rows.filter((r) => r.state !== 'unmatched' && r.variantId).map((r) => r.variantId));
        body.querySelectorAll('[data-pick]').forEach((inp) => {
          const idx = Number(inp.dataset.pick);
          const menu = body.querySelector(`[data-menu="${idx}"]`);
          const show = () => {
            const q = inp.value.trim().toLowerCase();
            if (q.length < 2) { menu.classList.add('hidden'); return; }
            const opts = [];
            for (const p of products) {
              const hay = `${p.name} ${p.code || ''} ${p.barcode || ''}`.toLowerCase();
              if (!hay.includes(q)) continue;
              for (const v of (p.variants || [])) {
                if (taken.has(v.id)) continue;
                opts.push({ p, v });
                if (opts.length >= 30) break;
              }
              if (opts.length >= 30) break;
            }
            menu.innerHTML = opts.length
              ? opts.map((o, k) => `<button type="button" data-opt="${k}" class="block w-full text-left px-3 py-2 hover:bg-[#fff8f4] text-sm">${esc(o.p.name)}${variantLabel(o.v) ? ` <span class="text-[11px] px-1.5 py-0.5 rounded bg-[#fff1e6]">${esc(variantLabel(o.v))}</span>` : ''}</button>`).join('')
              : '<div class="px-3 py-2 text-xs text-[#7d6c5c]">Sin resultados (o ya vinculado)</div>';
            menu.classList.remove('hidden');
            menu.querySelectorAll('[data-opt]').forEach((b) => b.addEventListener('mousedown', (ev) => {
              ev.preventDefault();
              const o = opts[Number(b.dataset.opt)];
              const st = (o.v.stocks ? Object.values(o.v.stocks).reduce((s, x) => s + Math.max(0, (x.qty || 0) - (x.reserved || 0)), 0) : 0);
              Object.assign(rows[idx], {
                state: 'match', by: 'title', _manual: true, _sel: true,
                variantId: o.v.id, productId: o.p.id, productName: o.p.name, variantName: variantLabel(o.v), systemStock: st,
              });
              render();
            }));
          };
          inp.addEventListener('input', show);
          inp.addEventListener('focus', show);
          inp.addEventListener('blur', () => setTimeout(() => menu.classList.add('hidden'), 150));
        });
      };
      render();

      applyBtn.addEventListener('click', async () => {
        const picked = rows.filter((r) => r.state === 'match' && r._sel && r.variantId);
        if (!picked.length) return;
        const ok = await confirmModal({
          title: 'Vincular con Mercado Libre',
          message: `Se van a vincular ${picked.length} publicación(es). El stock del sistema va a reemplazar el de Mercado Libre en cada una. ¿Confirmás?`,
          confirmLabel: 'Sí, vincular',
        });
        if (!ok) return;
        applyBtn.disabled = true; applyBtn.textContent = 'Vinculando…';
        try {
          const res = await P.mlSyncApply(picked.map((r) => ({ variantId: r.variantId, mlItemId: r.mlItemId, mlVariationId: r.mlVariationId, productId: r.productId })));
          const failed = new Map((res?.errors || []).map((e) => [e.variantId, e.error]));
          for (const r of picked) {
            if (failed.has(r.variantId)) { r.state = 'unmatched'; r.note = failed.get(r.variantId); r._sel = false; }
            else { r.state = 'linked'; r._sel = false; }
          }
          changed = changed || (res?.linked || 0) > 0;
          toast(`${res?.linked || 0} vinculada(s)${failed.size ? `, ${failed.size} con error` : ''} · el stock se está enviando a Mercado Libre`, failed.size ? 'warn' : 'success');
        } catch (err) { toast(errText(err), 'error'); }
        render();
      });
    },
  });
}
