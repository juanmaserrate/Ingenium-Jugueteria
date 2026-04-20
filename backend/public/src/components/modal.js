// Modal genérico. openModal({title, body, footer}) → devuelve promesa que resuelve al cerrar.

export function openModal({ title = '', bodyHTML = '', footerHTML = '', onOpen = null, size = 'md' } = {}) {
  return new Promise((resolve) => {
    const widths = { sm: 'max-w-md', md: 'max-w-2xl', lg: 'max-w-4xl', xl: 'max-w-6xl' };
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const titleId = 'modal-title-' + Math.random().toString(36).slice(2, 8);
    backdrop.innerHTML = `
      <div class="modal-content w-full ${widths[size] || widths.md}" role="dialog" aria-modal="true" aria-labelledby="${titleId}">
        <div class="flex justify-between items-start mb-6">
          <h3 id="${titleId}" class="text-2xl font-black text-[#241a0d]">${title}</h3>
          <button class="modal-close p-2 hover:bg-[#fff1e6] rounded-full transition-all" aria-label="Cerrar">
            <span class="material-symbols-outlined" aria-hidden="true">close</span>
          </button>
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
