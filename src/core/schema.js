// Definición declarativa de todos los stores de IndexedDB.
// Cada store tiene: nombre, keyPath, indexes opcionales.
// Este archivo es la fuente de verdad del modelo de datos.
//
// Nota: los "items" de ventas y devoluciones los guardo embebidos en el
// registro padre (más simple en IndexedDB, y siempre se leen juntos).

export const DB_NAME = 'IngeniumDB';
export const DB_VERSION = 2;

export const STORES = [
  // --- Núcleo ---
  { name: 'branches',         keyPath: 'id' },
  { name: 'users',            keyPath: 'id', indexes: [['branch_id', 'branch_id']] },
  { name: 'config',           keyPath: 'key' }, // key/value store (payment_methods, logo, etc.)

  // --- Catálogo ---
  { name: 'categories',       keyPath: 'id' },
  { name: 'subcategories',    keyPath: 'id', indexes: [['category_id', 'category_id']] },
  { name: 'brands',           keyPath: 'id' },
  { name: 'suppliers',        keyPath: 'id' },
  { name: 'products',         keyPath: 'id', indexes: [
      ['code', 'code', { unique: false }],
      ['name', 'name'],
      ['category_id', 'category_id'],
      ['brand_id', 'brand_id'],
      ['supplier_id', 'supplier_id'],
    ]},
  { name: 'variants',         keyPath: 'id', indexes: [['product_id', 'product_id']] },

  // Stock: composite key "{product_id}|{branch_id}"
  { name: 'stock',            keyPath: 'id', indexes: [
      ['product_id', 'product_id'],
      ['branch_id', 'branch_id'],
    ]},

  // --- Comercial ---
  // sales.items = [{product_id, variant_id?, qty, unit_price, cost_snapshot, discount_pct, discount_fixed, price_overridden, subtotal}]
  // sales.payments = [{method_id, method_name, amount}]
  { name: 'sales',            keyPath: 'id', indexes: [
      ['datetime', 'datetime'],
      ['branch_id', 'branch_id'],
      ['seller_id', 'seller_id'],
      ['customer_id', 'customer_id'],
      ['status', 'status'],
    ]},
  { name: 'draft_sales',      keyPath: 'id' }, // multi-pestaña, persistencia de ventas en curso
  { name: 'returns',          keyPath: 'id', indexes: [
      ['datetime', 'datetime'],
      ['branch_id', 'branch_id'],
      ['original_sale_id', 'original_sale_id'],
    ]},
  { name: 'credit_notes',     keyPath: 'id', indexes: [
      ['code', 'code', { unique: true }],
      ['customer_id', 'customer_id'],
      ['redeemed_at', 'redeemed_at'],
    ]},

  // --- Caja y finanzas ---
  { name: 'cash_movements',   keyPath: 'id', indexes: [
      ['datetime', 'datetime'],
      ['branch_id', 'branch_id'],
      ['type', 'type'],
    ]},
  { name: 'expenses',         keyPath: 'id', indexes: [
      ['datetime', 'datetime'],
      ['branch_id', 'branch_id'],
    ]},
  { name: 'monthly_pnl',      keyPath: 'id' }, // id = "YYYY-MM"; { fixed_costs:[], variable_costs:[] }
  { name: 'checks',           keyPath: 'id', indexes: [
      ['due_at', 'due_at'],
      ['supplier_id', 'supplier_id'],
      ['status', 'status'],
    ]},

  // --- Personas ---
  { name: 'customers',        keyPath: 'id', indexes: [['birthday', 'birthday']] },
  { name: 'employees',        keyPath: 'id', indexes: [['active', 'active']] },
  { name: 'shifts',           keyPath: 'id', indexes: [
      ['employee_id', 'employee_id'],
      ['date', 'date'],
    ]},

  // --- Operaciones ---
  { name: 'transfers',        keyPath: 'id', indexes: [
      ['datetime', 'datetime'],
      ['from_branch', 'from_branch'],
      ['to_branch', 'to_branch'],
    ]},
  { name: 'tasks',            keyPath: 'id', indexes: [
      ['column', 'column'],
      ['assignee_id', 'assignee_id'],
    ]},
  { name: 'calendar_events',  keyPath: 'id', indexes: [['date_from', 'date_from']] },

  // --- Meta ---
  { name: 'notifications',    keyPath: 'id', indexes: [
      ['user_id', 'user_id'],
      ['read_at', 'read_at'],
      ['datetime', 'datetime'],
    ]},
  { name: 'audit_log',        keyPath: 'id', indexes: [
      ['datetime', 'datetime'],
      ['user_id', 'user_id'],
      ['entity', 'entity'],
    ]},
  { name: 'counters',         keyPath: 'name' }, // nombres correlativos (sale_number, return_number, transfer_number...)

  // --- Integración Tienda Nube (cola local offline) ---
  { name: 'sync_queue_local', keyPath: 'id', indexes: [
      ['type', 'type'],
      ['createdAt', 'createdAt'],
    ]},
];

// Estados válidos (para validar)
export const SALE_STATUS = { DRAFT: 'draft', CONFIRMED: 'confirmed', CANCELLED: 'cancelled' };
export const CASH_MOVE_TYPE = {
  SALE: 'sale', RETURN: 'return', EXPENSE: 'expense',
  OPENING: 'opening', CLOSING: 'closing', ADJUSTMENT: 'adjustment',
};
export const CHECK_STATUS = { PENDING: 'pending', PAID: 'paid', BOUNCED: 'bounced' };
export const TASK_COLUMN = ['todo', 'doing', 'done'];

// Roles
export const ROLE = { ADMIN: 'admin', MANAGER: 'manager', SELLER: 'seller' };
