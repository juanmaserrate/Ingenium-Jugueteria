// Modal genérico. openModal({title, body, footer}) → devuelve promesa que resuelve al cerrar.

export function openModal({ title = '', bodyHTML = '', footerHTML = '', onOpen = null, size = 'md', minimizable = false } = {}) {
  return new Promise((resolve) => {
    const widths = { sm: 'max-w-md', md: 'max-w-2xl', lg: 'max-w-4xl', xl: 'max-w-6xl' };
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const titleId = 'modal-title-' + Math.random().toString(36).slice(2, 8);
    const minimizeBtnHTML = minimizable
      ? `<button class="modal-minimize p-2 hover:bg-[#fff1e6] rounded-full transition-all" aria-label="Minimizar" title="Minimizar"><span class="material-symbols-outlined" aria-hidden="true">remove</span></button>`
      : '';
    backdrop.innerHTML = `
      <div class="modal-content w-full ${widths[size] || widths.md}" role="dialog" aria-modal="true" aria-labelledby="${titleId}">
        <div class="flex justify-between items-start mb-6">
          <h3 id="${titleId}" class="text-2xl font-black text-[#241a0d]">${title}</h3>
          <div class="flex items-center gap-1">
            ${minimizeBtnHTML}
            <button class="modal-close p-2 hover:bg-[#fff1e6] rounded-full transition-all" aria-label="Cerrar">
              <span class="material-symbols-outlined" aria-hidden="true">close</span>
            </button>
          </div>
        </div>
        <div class="modal-body">${bodyHTML}</div>
        ${footerHTML ? `<div class="modal-footer mt-6 pt-6 border-t border-[#fff1e6] flex justify-end gap-3">${footerHTML}</div>` : ''}
      </div>
    `;
    const previouslyFocused = document.activeElement;
    const close = (value) => {
      backdrop.remove();
      if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
      resolve(value);
    };
    backdrop.querySelector('.modal-close').addEventListener('click', () => close(null));
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(null); });
    document.addEventListener('keydown', function esc(ev) {
      if (ev.key === 'Escape') { document.removeEventListener('keydown', esc); close(null); }
    });

    // Minimizar: colapsa el modal a una barra inferior-derecha; toggle restaura.
    if (minimizable) {
      const minimizeBtn = backdrop.querySelector('.modal-minimize');
      const content = backdrop.querySelector('.modal-content');
      const body = backdrop.querySelector('.modal-body');
      const footer = backdrop.querySelector('.modal-footer');
      let minimized = false;
      const setMinimized = (v) => {
        minimized = v;
        if (v) {
          backdrop.style.background = 'transparent';
          backdrop.style.pointerEvents = 'none';
          content.style.pointerEvents = 'auto';
          content.style.position = 'fixed';
          content.style.bottom = '16px';
          content.style.right = '16px';
          content.style.left = 'auto';
          content.style.top = 'auto';
          content.style.maxWidth = '360px';
          content.style.width = 'auto';
          content.style.maxHeight = 'none';
          content.style.padding = '12px 16px';
          content.style.cursor = 'pointer';
          if (body) body.style.display = 'none';
          if (footer) footer.style.display = 'none';
          minimizeBtn.querySelector('span').textContent = 'open_in_full';
          minimizeBtn.setAttribute('aria-label', 'Restaurar');
          minimizeBtn.title = 'Restaurar';
        } else {
          backdrop.style.background = '';
          backdrop.style.pointerEvents = '';
          content.style.pointerEvents = '';
          content.style.position = '';
          content.style.bottom = content.style.right = content.style.left = content.style.top = '';
          content.style.maxWidth = '';
          content.style.width = '';
          content.style.maxHeight = '';
          content.style.padding = '';
          content.style.cursor = '';
          if (body) body.style.display = '';
          if (footer) footer.style.display = '';
          minimizeBtn.querySelector('span').textContent = 'remove';
          minimizeBtn.setAttribute('aria-label', 'Minimizar');
          minimizeBtn.title = 'Minimizar';
        }
      };
      minimizeBtn.addEventListener('click', (e) => { e.stopPropagation(); setMinimized(!minimized); });
      // Click en el header minimizado restaura
      content.addEventListener('click', (e) => {
        if (!minimized) return;
        // No restaurar si el click fue en el botón cerrar o minimizar
        if (e.target.closest('.modal-close') || e.target.closest('.modal-minimize')) return;
        setMinimized(false);
      });
    }

    document.body.appendChild(backdrop);
    // Foco inicial: primer control del footer, si no el primer focusable del body
    setTimeout(() => {
      const first = backdrop.querySelector('.modal-footer button, .modal-body input, .modal-body button, .modal-body select, .modal-body textarea');
      if (first) first.focus();
    }, 50);
    if (onOpen) onOpen(backdrop, close);
  });
}

// Confirm minimalista
export function confirmModal({ title = 'Confirmar', message = '', confirmLabel = 'Confirmar', cancelLabel = 'Cancelar', danger = false } = {}) {
  return openModal({
    title,
    bodyHTML: `<p class="text-[#241a0d] text-base">${message}</p>`,
    footerHTML: `
      <button class="ing-btn-secondary" data-act="cancel">${cancelLabel}</button>
      <button class="ing-btn-primary ${danger ? 'bg-red-600' : ''}" data-act="ok">${confirmLabel}</button>
    `,
    size: 'sm',
    onOpen: (el, close) => {
      el.querySelector('[data-act="cancel"]').addEventListener('click', () => close(false));
      el.querySelector('[data-act="ok"]').addEventListener('click', () => close(true));
    },
  });
}
