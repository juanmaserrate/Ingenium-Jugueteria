// Modal reutilizable de "Datos para Tienda Nube" de un producto.
// Captura descripción, precio promo, peso, dimensiones, SEO, video, categorías TN
// e imágenes. Devuelve un objeto tnConfig (espeja ProductInput del backend) listo
// para persistir en PurchaseItem.tnConfig y publicar al recibir.
//
// Uso:
//   const cfg = await openTnProductModal({
//     initial,                       // tnConfig previo (o null)
//     uploadImage: async (file) => ({ url, storageKey }),  // sube y devuelve la ref
//   });
//   if (cfg) { item.tnConfig = cfg; }

import { openModal } from './modal.js';
import { api } from '../core/api.js';
import { toast } from '../core/notifications.js';

function escAttr(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function openTnProductModal({ initial = null, uploadImage = null } = {}) {
  const cfg = { ...(initial || {}) };
  const images = Array.isArray(cfg.images) ? [...cfg.images] : []; // [{url, storageKey}]
  const selectedCats = new Set((cfg.tnCategoryIds || []).map(Number));

  const body = `
    <div class="space-y-3">
      <label class="block">
        <span class="text-xs font-black text-[#7d6c5c] uppercase">Descripción</span>
        <textarea name="description" rows="3" class="ing-input mt-1" placeholder="Descripción del producto (acepta HTML básico)">${escAttr(cfg.description || '')}</textarea>
      </label>

      <div class="grid grid-cols-4 gap-3">
        <label><span class="text-xs font-black text-[#7d6c5c] uppercase">Precio promo $</span>
          <input name="promotionalPrice" type="number" step="0.01" min="0" class="ing-input mt-1" value="${cfg.promotionalPrice ?? ''}" placeholder="opcional" />
        </label>
        <label><span class="text-xs font-black text-[#7d6c5c] uppercase">Peso (kg)</span>
          <input name="weight" type="number" step="0.001" min="0" class="ing-input mt-1" value="${cfg.weight ?? ''}" placeholder="0.5" />
        </label>
        <label><span class="text-xs font-black text-[#7d6c5c] uppercase">URL slug</span>
          <input name="handle" type="text" class="ing-input mt-1" value="${escAttr(cfg.handle || '')}" placeholder="auto" />
        </label>
        <label><span class="text-xs font-black text-[#7d6c5c] uppercase">URL video</span>
          <input name="videoUrl" type="url" class="ing-input mt-1" value="${escAttr(cfg.videoUrl || '')}" placeholder="youtu.be/..." />
        </label>
      </div>

      <div class="grid grid-cols-3 gap-3">
        <label><span class="text-xs font-black text-[#7d6c5c] uppercase">Ancho (cm)</span>
          <input name="width" type="number" step="0.1" min="0" class="ing-input mt-1" value="${cfg.width ?? ''}" />
        </label>
        <label><span class="text-xs font-black text-[#7d6c5c] uppercase">Alto (cm)</span>
          <input name="height" type="number" step="0.1" min="0" class="ing-input mt-1" value="${cfg.height ?? ''}" />
        </label>
        <label><span class="text-xs font-black text-[#7d6c5c] uppercase">Profundidad (cm)</span>
          <input name="depth" type="number" step="0.1" min="0" class="ing-input mt-1" value="${cfg.depth ?? ''}" />
        </label>
      </div>

      <label class="block"><span class="text-xs font-black text-[#7d6c5c] uppercase">SEO Título</span>
        <input name="seoTitle" type="text" class="ing-input mt-1" value="${escAttr(cfg.seoTitle || '')}" placeholder="opcional" />
      </label>
      <label class="block"><span class="text-xs font-black text-[#7d6c5c] uppercase">SEO Descripción</span>
        <textarea name="seoDescription" rows="2" class="ing-input mt-1" placeholder="opcional">${escAttr(cfg.seoDescription || '')}</textarea>
      </label>

      <div>
        <span class="text-xs font-black text-[#7d6c5c] uppercase block mb-1">Categorías en Tienda Nube</span>
        <div class="border border-[#e3ceba] rounded-xl bg-white overflow-hidden">
          <div class="flex items-center gap-2 px-2 border-b border-[#e3ceba]">
            <span class="material-symbols-outlined text-base text-[#7d6c5c]">search</span>
            <input id="tnpf-cats-search" type="search" placeholder="Buscar categoría..." class="flex-1 py-2 text-sm bg-transparent focus:outline-none" />
          </div>
          <div id="tnpf-cats-box" class="max-h-40 overflow-auto p-1 text-sm">
            <div class="text-[#7d6c5c] italic p-2">Cargando categorías...</div>
          </div>
        </div>
      </div>

      <div>
        <span class="text-xs font-black text-[#7d6c5c] uppercase block mb-1">Imágenes</span>
        <div id="tnpf-thumbs" class="flex gap-2 flex-wrap mb-2"></div>
        <label class="inline-flex items-center gap-2 cursor-pointer px-3 py-2 bg-white border border-[#e3ceba] rounded-xl hover:bg-[#fff1e6]">
          <input type="file" multiple accept="image/png,image/jpeg,image/webp" id="tnpf-image-input" class="hidden" ${uploadImage ? '' : 'disabled'} />
          <span class="material-symbols-outlined text-base">add_photo_alternate</span>
          <span class="text-sm font-bold">Subir imágenes</span>
        </label>
        ${uploadImage ? '' : '<p class="text-xs text-[#7d6c5c] mt-1">Guardá la compra primero para poder subir imágenes.</p>'}
      </div>
    </div>
  `;

  return openModal({
    title: 'Datos para Tienda Nube',
    bodyHTML: body,
    footerHTML: `<button class="ing-btn-secondary" data-act="cancel">Cancelar</button><button class="ing-btn-primary" data-act="ok">Aplicar</button>`,
    size: 'lg',
    minimizable: true,
    closeOnBackdrop: false,
    onOpen: (el, close) => {
      // ---- Categorías TN (árbol plano + buscador), patrón de inventory.js ----
      (async () => {
        const box = el.querySelector('#tnpf-cats-box');
        try {
          const resp = await api('/api/tiendanube/categories');
          if (!resp?.connected) { box.innerHTML = '<div class="text-[#7d6c5c] italic p-2">Conectá Tienda Nube en Integraciones.</div>'; return; }
          const list = resp.categories || [];
          if (!list.length) { box.innerHTML = '<div class="text-[#7d6c5c] italic p-2">Tu tienda no tiene categorías.</div>'; return; }
          const sortKey = (n) => String(n || '').trim().replace(/^[^\p{L}\p{N}]+/u, '').toLowerCase();
          const sorted = [...list].sort((a, b) => sortKey(a.name).localeCompare(sortKey(b.name), 'es', { numeric: true, sensitivity: 'base' }));
          box.innerHTML = sorted.map((c) => `
            <label class="cat-row flex items-center gap-2 py-0.5 px-1 cursor-pointer hover:bg-[#fff1e6] rounded" data-cat-name="${escAttr(c.name.toLowerCase())}">
              <input type="checkbox" data-tn-cat="${c.id}" ${selectedCats.has(Number(c.id)) ? 'checked' : ''} class="rounded text-[#d82f1e] focus:ring-[#d82f1e]" />
              <span style="padding-left:${(c.level || 0) * 14}px">${escAttr(c.name)}</span>
            </label>`).join('');
          const search = el.querySelector('#tnpf-cats-search');
          search?.addEventListener('input', () => {
            const q = search.value.trim().toLowerCase();
            box.querySelectorAll('.cat-row').forEach((r) => r.classList.toggle('hidden', q && !(r.dataset.catName || '').includes(q)));
          });
        } catch {
          box.innerHTML = '<div class="text-red-700 italic p-2">No se pudieron cargar categorías.</div>';
        }
      })();

      // ---- Imágenes ----
      const renderThumbs = () => {
        const thumbs = el.querySelector('#tnpf-thumbs');
        if (!thumbs) return;
        thumbs.innerHTML = images.map((img, idx) => `
          <div class="relative w-20 h-20 rounded-lg overflow-hidden border border-[#e3ceba] bg-[#fff1e6]">
            <img src="${escAttr(img.url)}" alt="" class="w-full h-full object-cover" />
            <button type="button" data-img-del="${idx}" class="absolute top-0 right-0 w-5 h-5 bg-red-600 text-white rounded-full text-xs leading-none hover:bg-red-700">×</button>
          </div>`).join('');
        thumbs.querySelectorAll('[data-img-del]').forEach((b) => b.addEventListener('click', () => {
          images.splice(Number(b.dataset.imgDel), 1); renderThumbs();
        }));
      };
      renderThumbs();
      const imgInput = el.querySelector('#tnpf-image-input');
      imgInput?.addEventListener('change', async (ev) => {
        const files = Array.from(ev.target.files || []);
        ev.target.value = '';
        if (!uploadImage) return;
        for (const f of files) {
          try {
            const ref = await uploadImage(f); // { url, storageKey }
            if (ref?.url && ref?.storageKey) images.push({ url: ref.url, storageKey: ref.storageKey });
          } catch (e) {
            console.warn('upload staging falló', e);
            toast(`No se pudo subir "${f.name}"`, 'error');
          }
        }
        renderThumbs();
      });

      el.querySelector('[data-act="cancel"]').addEventListener('click', () => close(null));
      el.querySelector('[data-act="ok"]').addEventListener('click', () => {
        const form = el; // los inputs están sueltos en el body
        const val = (name) => form.querySelector(`[name="${name}"]`)?.value ?? '';
        const num = (name) => { const v = val(name); return v === '' ? null : Number(v); };
        const tnCategoryIds = Array.from(el.querySelectorAll('#tnpf-cats-box input[data-tn-cat]:checked'))
          .map((cb) => Number(cb.dataset.tnCat)).filter((n) => !Number.isNaN(n));
        close({
          description: val('description') || null,
          promotionalPrice: num('promotionalPrice'),
          weight: num('weight'),
          width: num('width'),
          height: num('height'),
          depth: num('depth'),
          seoTitle: val('seoTitle') || null,
          seoDescription: val('seoDescription') || null,
          handle: val('handle') || null,
          videoUrl: val('videoUrl') || null,
          tnCategoryIds,
          images,
        });
      });
    },
  });
}
