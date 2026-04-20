// Sidebar navegación. Se ancla al hash actual y se resalta solo.

const NAV = [
  { section: 'Operación' },
  { path: '/dashboard',    label: 'Panel',            icon: 'dashboard' },
  { path: '/pos',          label: 'Ventas',           icon: 'point_of_sale' },
  { path: '/returns',      label: 'Devoluciones',     icon: 'assignment_return' },
  { path: '/cash',         label: 'Caja',             icon: 'account_balance_wallet' },

  { section: 'Catálogo' },
  { path: '/inventory',    label: 'Inventario',       icon: 'inventory_2' },

  { section: 'Tienda Nube' },
  { path: '/ventas-web',          label: 'Ventas Web',        icon: 'shopping_bag' },
  { path: '/productos-pendientes',label: 'Productos TN',      icon: 'new_releases' },
  { path: '/integraciones',       label: 'Integraciones',     icon: 'link' },
  { path: '/conflictos',          label: 'Conflictos de sync',icon: 'sync_problem' },

  { section: 'Comercial' },
  { path: '/crm',          label: 'Clientes',         icon: 'group' },
  { path: '/balance',      label: 'Saldo',            icon: 'trending_up' },
  { path: '/profits',      label: 'Ganancias',        icon: 'paid' },
  { path: '/contribution', label: 'Contribución',     icon: 'pie_chart' },
  { path: '/checks',       label: 'Cheques',          icon: 'receipt_long' },

  { section: 'Gente' },
  { path: '/employees',    label: 'Empleados',        icon: 'badge' },
  { path: '/tasks',        label: 'Tareas',           icon: 'task_alt' },

  { section: 'Adicional' },
  { path: '/calendar',     label: 'Calendario',       icon: 'calendar_month' },
  { path: '/reports',      label: 'Reportes',         icon: 'summarize' },
  { path: '/history',      label: 'Historial',        icon: 'history' },
  { path: '/settings',     label: 'Configuración',    icon: 'settings' },
];

function renderNav(currentPath) {
  return NAV.map(item => {
    if (item.section) {
      return `<div class="px-6 pt-3 pb-1 text-[0.625rem] font-black text-[#7d6c5c] dark:text-[#c9b6a4] uppercase tracking-[0.18em]">${item.section}</div>`;
    }
    const active = currentPath === item.path || currentPath.startsWith(item.path + '/');
    if (active) {
      return `<a href="#${item.path}" class="bg-[#d82f1e] text-white rounded-full mx-3 px-4 py-2 shadow-md flex items-center gap-3 transition-transform active:scale-95">
        <span class="material-symbols-outlined text-[20px]">${item.icon}</span>
        <span class="font-bold text-[0.85rem]">${item.label}</span>
      </a>`;
    }
    return `<a href="#${item.path}" class="text-[#241a0d] dark:text-[#fff1e6] opacity-85 hover:opacity-100 px-6 py-2 flex items-center gap-3 hover:bg-[#f5dfca] dark:hover:bg-[#2a2018] transition-all duration-200">
      <span class="material-symbols-outlined text-[20px]">${item.icon}</span>
      <span class="font-semibold text-[0.85rem]">${item.label}</span>
    </a>`;
  }).join('');
}

export function mountSidebar(el, { onLogout }) {
  const render = () => {
    const path = location.hash.slice(1) || '/dashboard';
    el.innerHTML = `
      <div class="px-6 mb-3">
        <div class="flex items-center gap-1">
          <span class="text-2xl font-black tracking-tighter text-[#d82f1e]">Ingenium</span>
        </div>
        <p class="text-[0.625rem] font-bold text-[#7d6c5c] dark:text-[#c9b6a4] uppercase tracking-[0.18em]">Sistema de Ventas</p>
      </div>
      <nav class="flex-1 overflow-y-auto">
        ${renderNav(path)}
      </nav>
      <div class="mt-2 px-3 pb-3 pt-2 border-t border-[#fff1e6] dark:border-[#2a2018] space-y-1">
        <button id="btn-new-sale" class="w-full bg-[#d82f1e] text-white font-bold py-2.5 rounded-2xl shadow-md flex items-center justify-center gap-2 hover:brightness-110 active:scale-95 transition-all text-sm">
          <span class="material-symbols-outlined text-sm">add_circle</span>
          Nueva venta
        </button>
        <a href="#" id="btn-logout" class="text-[#7d6c5c] dark:text-[#c9b6a4] px-4 py-1.5 flex items-center gap-3 hover:bg-[#f5dfca] dark:hover:bg-[#2a2018] rounded-full transition-all text-sm">
          <span class="material-symbols-outlined text-[20px]">logout</span>
          <span>Cerrar sesión</span>
        </a>
      </div>
    `;
    el.querySelector('#btn-logout').addEventListener('click', (e) => {
      e.preventDefault();
      onLogout && onLogout();
    });
    el.querySelector('#btn-new-sale').addEventListener('click', () => {
      location.hash = '/pos';
    });
  };

  render();
  window.addEventListener('hashchange', render);
}
