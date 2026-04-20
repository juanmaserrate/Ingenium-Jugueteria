// U-9: estados vacíos ilustrados con CTA.
// Uso:
//   emptyState({ icon: 'inbox', title: 'Sin cheques', hint: '...', ctaLabel: 'Nuevo', ctaAttr: 'data-act="new"' })
// Devuelve HTML listo para insertar. El binding del botón lo resuelve el caller
// con querySelector('[data-act="new"]').

export function emptyState({ icon = 'inbox', title = 'Sin resultados', hint = '', ctaLabel = '', ctaAttr = '', compact = false } = {}) {
  const pad = compact ? 'py-8' : 'py-14';
  const btn = ctaLabel ? `
    <button ${ctaAttr} class="mt-5 inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-[#d82f1e] text-white font-black text-sm shadow-md hover:brightness-110 active:scale-95 transition">
      <span class="material-symbols-outlined text-base">add_circle</span>
      ${ctaLabel}
    </button>
  ` : '';
  return `
    <div class="empty-state text-center ${pad} px-4">
      <div class="mx-auto w-20 h-20 rounded-full bg-[#fff1e6] flex items-center justify-center mb-4">
        <span class="material-symbols-outlined text-5xl text-[#d82f1e]">${icon}</span>
      </div>
      <h3 class="text-lg font-black text-[#241a0d]">${title}</h3>
      ${hint ? `<p class="text-sm text-[#7d6c5c] mt-1 max-w-sm mx-auto">${hint}</p>` : ''}
      ${btn}
    </div>
  `;
}

// Helper para tablas: <tr><td colspan=N>... empty state ...</td></tr>
export function emptyRow(colspan, opts) {
  return `<tr><td colspan="${colspan}">${emptyState(opts)}</td></tr>`;
}
