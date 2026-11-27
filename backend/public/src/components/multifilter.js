// Filtro desplegable de selección múltiple con búsqueda (Inventario, Ventas, Reportes).
// Un botón ("Categoría ▾", con la cantidad marcada) abre un panel con un buscador y la lista
// de opciones con casillas. Marcar/desmarcar avisa al instante (onChange) y el panel queda
// abierto: si la pantalla se redibuja, se vuelve a abrir solo con la misma búsqueda.
// Sin nada marcado = sin filtro.

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Panel abierto { key, q, scroll } para reabrirlo después de redibujar.
let openState = null;
let outsideBound = false;

function badge(n) {
  return n > 0 ? ` <span class="mf-badge inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-[#d82f1e] text-white text-[11px] font-black">${n}</span>` : '';
}

// HTML del botón + panel. key debe ser único en la pantalla.
// opts.full = ocupa todo el ancho (para formularios/diálogos).
export function multiFilterHtml(key, label, nSelected = 0, opts = {}) {
  const on = nSelected > 0;
  return `<div class="mf-wrap relative ${opts.full ? 'w-full' : ''}" data-mf="${esc(key)}" data-mf-label="${esc(label)}">
    <button type="button" class="mf-btn ing-filter inline-flex items-center gap-1.5 ${opts.full ? 'w-full justify-between' : ''} ${on ? '!border-[#d82f1e] text-[#d82f1e] font-bold' : ''}" aria-haspopup="true">
      <span class="mf-label">${esc(label)}${badge(nSelected)}</span>
      <span class="material-symbols-outlined text-base">expand_more</span>
    </button>
    <div class="mf-panel hidden absolute z-50 mt-1 w-72 max-w-[90vw] bg-white border border-[#e3ceba] rounded-xl shadow-lg text-sm p-2"></div>
  </div>`;
}

export function closeMultiFilters() {
  openState = null;
  document.querySelectorAll('.mf-panel').forEach((p) => p.classList.add('hidden'));
}

// options: [{ id, name, count?, muted? }]. selected: array de ids. onChange(ids[]).
export function mountMultiFilter(root, key, { options, selected, onChange, searchPlaceholder = 'Buscar…' }) {
  const wrap = root.querySelector(`[data-mf="${CSS.escape(key)}"]`);
  if (!wrap) return null;
  const btn = wrap.querySelector('.mf-btn');
  const panel = wrap.querySelector('.mf-panel');
  const label = wrap.dataset.mfLabel || '';
  const sel = new Set(selected || []);
  const showSearch = options.length > 6;

  const refreshButton = () => {
    wrap.querySelector('.mf-label').innerHTML = esc(label) + badge(sel.size);
    btn.classList.toggle('!border-[#d82f1e]', sel.size > 0);
    btn.classList.toggle('text-[#d82f1e]', sel.size > 0);
    btn.classList.toggle('font-bold', sel.size > 0);
  };

  const draw = (q = '', scroll = 0) => {
    const needle = norm(q.trim());
    const list = needle ? options.filter((o) => norm(o.name).includes(needle)) : options;
    panel.innerHTML = `
      ${showSearch ? `<input class="mf-search ing-input w-full !py-1.5 text-sm" placeholder="${esc(searchPlaceholder)}" value="${esc(q)}" autocomplete="off" />` : ''}
      <div class="flex items-center justify-between px-1 py-1.5 text-xs">
        <button type="button" class="mf-all text-[#d82f1e] font-bold hover:underline disabled:opacity-40" ${list.length ? '' : 'disabled'}>Marcar ${needle ? 'los encontrados' : 'todos'}</button>
        <button type="button" class="mf-none text-[#7d6c5c] font-bold hover:underline disabled:opacity-40" ${sel.size ? '' : 'disabled'}>Desmarcar todo</button>
      </div>
      <div class="mf-list max-h-64 overflow-auto">
        ${list.length ? list.map((o) => `
          <label class="flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer hover:bg-[#fff1e6]">
            <input type="checkbox" data-mfopt="${esc(o.id)}" ${sel.has(o.id) ? 'checked' : ''} class="rounded text-[#d82f1e] focus:ring-[#d82f1e]" />
            <span class="flex-1 ${o.muted ? 'italic text-[#7d6c5c]' : ''}">${esc(o.name)}</span>
            ${o.count != null ? `<span class="text-xs text-[#7d6c5c]">${o.count}</span>` : ''}
          </label>`).join('') : `<div class="px-2 py-2 text-[#7d6c5c] italic">Sin resultados</div>`}
      </div>`;
    panel.querySelector('.mf-list').scrollTop = scroll;
    const search = panel.querySelector('.mf-search');
    search?.addEventListener('input', () => {
      const pos = search.selectionStart;
      draw(search.value, 0);
      const s2 = panel.querySelector('.mf-search');
      s2.focus(); try { s2.setSelectionRange(pos, pos); } catch { /* noop */ }
    });
    search?.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    const apply = () => {
      openState = { key, q: panel.querySelector('.mf-search')?.value || '', scroll: panel.querySelector('.mf-list')?.scrollTop || 0 };
      refreshButton();
      // El panel sigue abierto: se redibuja la lista (para "Desmarcar todo") y se avisa.
      draw(openState.q, openState.scroll);
      onChange([...sel]);
    };
    panel.querySelectorAll('[data-mfopt]').forEach((cb) => cb.addEventListener('change', () => {
      if (cb.checked) sel.add(cb.dataset.mfopt); else sel.delete(cb.dataset.mfopt);
      apply();
    }));
    panel.querySelector('.mf-all')?.addEventListener('click', () => { for (const o of list) sel.add(o.id); apply(); });
    panel.querySelector('.mf-none')?.addEventListener('click', () => { sel.clear(); apply(); });
  };
  const open = (q = '', scroll = 0) => {
    document.querySelectorAll('.mf-panel').forEach((p) => { if (p !== panel) p.classList.add('hidden'); });
    draw(q, scroll);
    panel.classList.remove('hidden');
    openState = { key, q, scroll };
    const s = panel.querySelector('.mf-search');
    if (s) { s.focus(); try { s.setSelectionRange(q.length, q.length); } catch { /* noop */ } }
  };
  const close = () => { panel.classList.add('hidden'); if (openState?.key === key) openState = null; };
  btn.addEventListener('click', () => (panel.classList.contains('hidden') ? open() : close()));

  if (!outsideBound) {
    outsideBound = true;
    document.addEventListener('mousedown', (e) => {
      if (e.target.closest?.('.mf-wrap')) return;
      closeMultiFilters();
    });
  }
  // Estaba abierto antes de redibujar la pantalla → se reabre igual.
  if (openState?.key === key) open(openState.q, openState.scroll);
  return { get: () => [...sel] };
}
