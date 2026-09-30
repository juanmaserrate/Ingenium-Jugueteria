// Barra de navegación superior (header). Antes era un sidebar vertical; ahora es un
// header horizontal con un menú desplegable por categoría, para dejar todo el ancho de
// la pantalla libre para los módulos. Se ancla al hash actual y resalta la categoría/ítem
// activo. El nombre del export se mantiene (mountSidebar) para no tocar app.html de más.

const GROUPS = [
  { section: 'Operación', icon: 'point_of_sale', items: [
    { path: '/dashboard', label: 'Panel',        icon: 'dashboard' },
    { path: '/pos',       label: 'POS',          icon: 'point_of_sale' },
    { path: '/ventas',    label: 'Ventas',       icon: 'receipt_long' },
    { path: '/returns',   label: 'Devoluciones', icon: 'assignment_return' },
    { path: '/cash',      label: 'Caja',         icon: 'account_balance_wallet' },
  ]},
  { section: 'Catálogo', icon: 'inventory_2', items: [
    { path: '/inventory', label: 'Inventario', icon: 'inventory_2' },
    { path: '/purchases', label: 'Compras',    icon: 'shopping_cart' },
  ]},
  { section: 'Tienda Nube', icon: 'storefront', items: [
    { path: '/ventas-web',           label: 'Ventas Web',         icon: 'shopping_bag' },
    { path: '/productos-pendientes', label: 'Productos TN',       icon: 'new_releases' },
    { path: '/integraciones',        label: 'Integraciones',      icon: 'link' },
    { path: '/conflictos',           label: 'Conflictos de sync', icon: 'sync_problem' },
  ]},
  { section: 'Comercial', icon: 'trending_up', items: [
    { path: '/crm',          label: 'Clientes',     icon: 'group' },
    { path: '/balance',      label: 'Saldo',        icon: 'trending_up' },
    { path: '/profits',      label: 'Ganancias',    icon: 'paid' },
    { path: '/contribution', label: 'Contribución', icon: 'pie_chart' },
    { path: '/checks',       label: 'Cheques',      icon: 'receipt_long' },
  ]},
  { section: 'Gente', icon: 'badge', items: [
    { path: '/employees', label: 'Empleados', icon: 'badge' },
    { path: '/tasks',     label: 'Tareas',    icon: 'task_alt' },
  ]},
  { section: 'Adicional', icon: 'more_horiz', items: [
    { path: '/calendar', label: 'Calendario',    icon: 'calendar_month' },
    { path: '/reports',  label: 'Reportes',      icon: 'summarize' },
    { path: '/history',  label: 'Historial',     icon: 'history' },
    { path: '/settings', label: 'Configuración', icon: 'settings' },
  ]},
];

function groupHTML(group, currentPath) {
  const activeInGroup = group.items.some(i => currentPath === i.path || currentPath.startsWith(i.path + '/'));
  const items = group.items.map(i => {
    const active = currentPath === i.path || currentPath.startsWith(i.path + '/');
    return `<a href="#${i.path}" data-navitem class="flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm transition-colors ${active
      ? 'bg-[#d82f1e] text-white font-bold'
      : 'text-[#241a0d] dark:text-[#fff1e6] hover:bg-[#f5dfca] dark:hover:bg-[#2a2018] font-semibold'}">
      <span class="material-symbols-outlined text-[20px]">${i.icon}</span>${i.label}
    </a>`;
  }).join('');
  return `
    <div class="nav-group relative">
      <button data-navtoggle class="flex items-center gap-1.5 px-3 py-2 rounded-full text-sm font-bold whitespace-nowrap transition-colors ${activeInGroup
        ? 'bg-[#fff1e6] dark:bg-[#2a2018] text-[#d82f1e]'
        : 'text-[#241a0d] dark:text-[#fff1e6] hover:bg-[#fff1e6] dark:hover:bg-[#2a2018]'}">
        <span class="material-symbols-outlined text-[20px]">${group.icon}</span>
        <span class="hidden md:inline">${group.section}</span>
        <span class="material-symbols-outlined text-[18px]">expand_more</span>
      </button>
      <div data-navmenu class="hidden absolute left-0 mt-1 min-w-[210px] bg-white dark:bg-[#1a1410] border border-[#e3ceba] dark:border-[#2a2018] rounded-2xl shadow-xl p-1.5 z-50 space-y-0.5">
        ${items}
      </div>
    </div>`;
}

export function mountSidebar(el, { onLogout }) {
  const render = () => {
    const path = location.hash.slice(1) || '/dashboard';
    el.innerHTML = `
      <a href="#/dashboard" class="flex items-center shrink-0 pr-2">
        <span class="text-xl font-black tracking-tighter text-[#d82f1e]">Ingenium</span>
      </a>
      <nav class="flex flex-wrap items-center gap-1">
        ${GROUPS.map(g => groupHTML(g, path)).join('')}
      </nav>
      <button id="btn-new-sale" class="ml-1 shrink-0 bg-[#d82f1e] text-white font-bold px-3.5 py-2 rounded-full shadow-md flex items-center gap-1.5 hover:brightness-110 active:scale-95 transition-all text-sm">
        <span class="material-symbols-outlined text-[18px]">add_circle</span>
        <span class="hidden lg:inline">Nueva venta</span>
      </button>`;

    // Desplegables: abrir/cerrar; solo uno abierto a la vez.
    const closeAll = () => el.querySelectorAll('[data-navmenu]').forEach(m => m.classList.add('hidden'));
    el.querySelectorAll('.nav-group').forEach(group => {
      const toggle = group.querySelector('[data-navtoggle]');
      const menu = group.querySelector('[data-navmenu]');
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const wasHidden = menu.classList.contains('hidden');
        closeAll();
        if (wasHidden) menu.classList.remove('hidden');
      });
      // Al elegir un ítem, cerrar el menú (la navegación por hash re-renderiza igual).
      menu.querySelectorAll('[data-navitem]').forEach(a => a.addEventListener('click', closeAll));
    });
    el.querySelector('#btn-new-sale').addEventListener('click', () => { location.hash = '/pos'; });
  };

  // Cerrar los desplegables al hacer click fuera del nav.
  document.addEventListener('click', (e) => {
    if (!el.contains(e.target)) el.querySelectorAll('[data-navmenu]').forEach(m => m.classList.add('hidden'));
  });

  // onLogout se expone para el topbar (botón de cerrar sesión) vía window.
  window.__ingLogout = onLogout;

  render();
  window.addEventListener('hashchange', render);
}
