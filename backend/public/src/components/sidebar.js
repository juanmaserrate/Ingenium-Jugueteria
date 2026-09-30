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
      <button data-navtoggle class="flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm font-bold whitespace-nowrap transition-colors ${activeInGroup
        ? 'bg-white/20 text-white'
        : 'text-white/85 hover:bg-white/10 hover:text-white'}">
        <span>${group.section}</span>
        <span class="nav-chevron material-symbols-outlined text-[18px] opacity-80 transition-transform duration-200">expand_more</span>
      </button>
      <div data-navmenu class="hidden absolute left-0 mt-1.5 min-w-[220px] bg-white dark:bg-[#1a1410] border border-[#e3ceba] dark:border-[#2a2018] rounded-2xl shadow-2xl p-1.5 z-50 space-y-0.5">
        ${items}
      </div>
    </div>`;
}

export function mountSidebar(el, { onLogout }) {
  const render = () => {
    const path = location.hash.slice(1) || '/dashboard';
    el.innerHTML = `
      <nav class="flex flex-wrap items-center gap-0.5 min-w-0">
        ${GROUPS.map(g => groupHTML(g, path)).join('')}
      </nav>
      <button id="btn-new-sale" class="shrink-0 bg-white text-[#d82f1e] font-bold px-4 py-1.5 rounded-full shadow flex items-center gap-1.5 hover:bg-[#fff1e6] active:scale-95 transition-all text-sm">
        <span class="material-symbols-outlined text-[18px]">add_circle</span>
        <span>Nueva venta</span>
      </button>`;

    // Desplegables: abrir/cerrar; solo uno abierto a la vez. El chevron rota al abrir.
    const closeAll = () => el.querySelectorAll('.nav-group').forEach(g => {
      g.querySelector('[data-navmenu]')?.classList.add('hidden');
      g.querySelector('.nav-chevron')?.classList.remove('rotate-180');
    });
    el.querySelectorAll('.nav-group').forEach(group => {
      const toggle = group.querySelector('[data-navtoggle]');
      const menu = group.querySelector('[data-navmenu]');
      const chev = group.querySelector('.nav-chevron');
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const wasHidden = menu.classList.contains('hidden');
        closeAll();
        if (wasHidden) { menu.classList.remove('hidden'); chev?.classList.add('rotate-180'); }
      });
      // Al elegir un ítem, cerrar el menú (la navegación por hash re-renderiza igual).
      menu.querySelectorAll('[data-navitem]').forEach(a => a.addEventListener('click', closeAll));
    });
    el.querySelector('#btn-new-sale').addEventListener('click', () => { location.hash = '/pos'; });
  };

  // Cerrar los desplegables al hacer click fuera del nav.
  document.addEventListener('click', (e) => {
    if (!el.contains(e.target)) el.querySelectorAll('.nav-group').forEach(g => {
      g.querySelector('[data-navmenu]')?.classList.add('hidden');
      g.querySelector('.nav-chevron')?.classList.remove('rotate-180');
    });
  });

  // onLogout se expone para el topbar (botón de cerrar sesión) vía window.
  window.__ingLogout = onLogout;

  render();
  window.addEventListener('hashchange', render);
}
