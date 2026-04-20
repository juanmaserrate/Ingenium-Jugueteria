// U-7: persistir filtros en sessionStorage por módulo.
// Uso:
//   const state = loadFilter('history', { search: '', action: '', ... });
//   ... mutar state ...
//   saveFilter('history', state);
//
// Usamos sessionStorage (no localStorage) para que los filtros no persistan
// entre cierres del navegador — sólo entre navegaciones de la misma sesión.

const prefix = 'ingenium_filter_';

export function loadFilter(key, defaults = {}) {
  try {
    const raw = sessionStorage.getItem(prefix + key);
    if (!raw) return { ...defaults };
    return { ...defaults, ...JSON.parse(raw) };
  } catch { return { ...defaults }; }
}

export function saveFilter(key, state) {
  try { sessionStorage.setItem(prefix + key, JSON.stringify(state)); } catch {}
}

export function clearFilter(key) {
  try { sessionStorage.removeItem(prefix + key); } catch {}
}

// Helper combinado: asigna state y lo persiste en una sola operación.
export function persist(key, state, patch) {
  Object.assign(state, patch);
  saveFilter(key, state);
}
