// Router por hash: #/pos, #/inventory, etc.
// Cada módulo exporta un mount(container, params) y un unmount() opcional.

import { isAdmin } from './auth.js';

// Rutas solo-admin: si un encargado entra por URL, se lo manda al POS.
const ADMIN_ONLY = new Set([
  '/dashboard', '/productos-pendientes', '/integraciones', '/conflictos', '/mercadolibre',
  '/balance', '/profits', '/contribution', '/checks',
  '/employees', '/tasks', '/calendar', '/reports', '/history', '/settings',
]);

const routes = new Map();
let currentUnmount = null;
let container = null;
// Token de secuencia: cada render() reclama un número. Como render() es async y el
// #router-outlet es un nodo fijo compartido, dos navegaciones seguidas pueden pisarse
// (un mount lento termina DESPUÉS del nuevo y escribe su contenido encima). Tras cada
// await chequeamos seguir siendo el render vigente; si no, abortamos.
let renderSeq = 0;

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
  const mySeq = ++renderSeq; // reclamo este render; cualquier navegación posterior lo invalida
  if (typeof currentUnmount === 'function') {
    try { currentUnmount(); } catch (e) { console.error(e); }
    currentUnmount = null;
  }
  container.innerHTML = '<div class="ing-stub"><span class="material-symbols-outlined">hourglass_top</span><p>Cargando...</p></div>';

  // Split path y params "#/pos" o "#/sale/123". Se saca el query ("?connected=1",
  // "?error=oauth", etc.) ANTES de matchear la ruta — si no, queda dentro de la key y da
  // "Ruta no encontrada". El query sigue en location.hash para que el módulo lo lea.
  const [base, ...rest] = path.split('?')[0].split('/').filter(Boolean);
  const key = `/${base || 'dashboard'}`;
  // Guard de rol: el encargado no accede a módulos de administración ni por URL.
  if (ADMIN_ONLY.has(key) && !isAdmin()) {
    if (location.hash !== '#/pos') { location.hash = '/pos'; return; }
    const target = routes.get('/pos');
    if (target) {
      const mod = await target();
      if (mySeq !== renderSeq) return;
      const ret = await (mod.mount || mod.default)(container, { params: [] });
      if (mySeq !== renderSeq) { if (typeof ret === 'function') { try { ret(); } catch {} } return; }
      if (typeof ret === 'function') currentUnmount = ret;
    }
    return;
  }
  const loader = routes.get(key) || routes.get('/404');
  if (!loader) {
    container.innerHTML = `<div class="ing-stub"><span class="material-symbols-outlined">error</span><p>Ruta no encontrada: ${path}</p></div>`;
    return;
  }
  try {
    const mod = await loader();
    if (mySeq !== renderSeq) return; // navegaron a otra ruta mientras cargaba el módulo: no montamos
    const mount = mod.mount || mod.default;
    const ret = await mount(container, { params: rest });
    if (mySeq !== renderSeq) {
      // Navegaron DURANTE el mount: este módulo pudo haber pintado encima del nuevo.
      // Desmontamos lo que acabamos de montar y repintamos la ruta vigente.
      if (typeof ret === 'function') { try { ret(); } catch {} }
      void render(location.hash.slice(1) || '/pos');
      return;
    }
    if (typeof ret === 'function') currentUnmount = ret;
  } catch (err) {
    if (mySeq !== renderSeq) return; // error de un render viejo: no pisamos la pantalla actual
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
