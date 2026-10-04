// Router por hash: #/pos, #/inventory, etc.
// Cada módulo exporta un mount(container, params) y un unmount() opcional.

import { isAdmin } from './auth.js';

// Rutas solo-admin: si un encargado entra por URL, se lo manda al POS.
const ADMIN_ONLY = new Set([
  '/dashboard', '/productos-pendientes', '/integraciones', '/conflictos',
  '/balance', '/profits', '/contribution', '/checks',
  '/employees', '/tasks', '/calendar', '/reports', '/history', '/settings',
]);

const routes = new Map();
let currentUnmount = null;
let container = null;

export function registerRoute(path, loader) {
  routes.set(path, loader);
}

export function setRouterContainer(el) { container = el; }

export async function navigate(path) {
  if (location.hash !== `#${path}`) {
    location.hash = path;
    return; // hashchange event will trigger render
  }
  // Mismo hash: forzar re-render para que la ruta vuelva a montarse limpia
  await render(path);
}

async function render(path) {
  if (!container) return;
  if (typeof currentUnmount === 'function') {
    try { currentUnmount(); } catch (e) { console.error(e); }
    currentUnmount = null;
  }
  container.innerHTML = '<div class="ing-stub"><span class="material-symbols-outlined">hourglass_top</span><p>Cargando...</p></div>';

  // Split path y params "#/pos" o "#/sale/123"
  const [base, ...rest] = path.split('/').filter(Boolean);
  const key = `/${base || 'dashboard'}`;
  // Guard de rol: el encargado no accede a módulos de administración ni por URL.
  if (ADMIN_ONLY.has(key) && !isAdmin()) {
    if (location.hash !== '#/pos') { location.hash = '/pos'; return; }
    const target = routes.get('/pos');
    if (target) { const mod = await target(); await (mod.mount || mod.default)(container, { params: [] }); return; }
  }
  const loader = routes.get(key) || routes.get('/404');
  if (!loader) {
    container.innerHTML = `<div class="ing-stub"><span class="material-symbols-outlined">error</span><p>Ruta no encontrada: ${path}</p></div>`;
    return;
  }
  try {
    const mod = await loader();
    const mount = mod.mount || mod.default;
    const ret = await mount(container, { params: rest });
    if (typeof ret === 'function') currentUnmount = ret;
  } catch (err) {
    console.error(err);
    container.innerHTML = `<div class="ing-stub"><span class="material-symbols-outlined">error</span><p>Error cargando módulo</p><pre class="text-xs">${err.message}</pre></div>`;
  }
}

export function startRouter(defaultPath = '/dashboard') {
  window.addEventListener('hashchange', () => {
    const p = location.hash.slice(1) || defaultPath;
    render(p);
  });
  const p = location.hash.slice(1) || defaultPath;
  render(p);
}
