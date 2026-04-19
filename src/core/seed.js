// Semilla inicial: sucursales, usuarios, config, y unos productos/clientes/empleados de ejemplo.
// Se corre una vez si la DB está vacía (o desde Configuración → Reset demo).

import { put, count, newId, stockId, clear } from './db.js';
import { STORES } from './schema.js';

// Métodos de pago por defecto (configurables después desde Settings)
const DEFAULT_PAYMENT_METHODS = [
  { id: 'cash',       name: 'Efectivo',         affects_cash: true,  icon: 'payments' },
  { id: 'card_debit', name: 'Tarjeta de Débito', affects_cash: false, icon: 'credit_card' },
  { id: 'card_credit',name: 'Tarjeta de Crédito',affects_cash: false, icon: 'credit_card' },
  { id: 'transfer',   name: 'Transferencia',    affects_cash: false, icon: 'account_balance' },
  { id: 'mercadopago',name: 'MercadoPago',      affects_cash: false, icon: 'qr_code' },
  { id: 'credit_note',name: 'Vale',             affects_cash: false, icon: 'confirmation_number' },
];

export async function isSeedNeeded() {
  return (await count('branches')) === 0;
}

export async function resetAllData() {
  for (const s of STORES) {
    try { await clear(s.name); } catch {}
  }
}

export async function runSeed({ force = false } = {}) {
  if (!force && !(await isSeedNeeded())) return false;
  if (force) await resetAllData();

  // --- Sucursales ---
  const lomas    = { id: 'br_lomas',    name: 'Lomas',    address: 'Lomas de Zamora' };
  const banfield = { id: 'br_banfield', name: 'Banfield', address: 'Banfield' };
  await put('branches', lomas);
  await put('branches', banfield);

  // --- Usuarios ---
  // Dos usuarios principales (cajeros) + vendedores por sucursal + admin.
  const users = [
    { id: 'u_admin',   name: 'Admin',    lastname: '',           branch_id: lomas.id,    role: 'admin',   pin: '1234' },
    { id: 'u_lomas',   name: 'Lomas',    lastname: '',           branch_id: lomas.id,    role: 'cashier', pin: '1111' },
    { id: 'u_banf',    name: 'Banfield', lastname: '',           branch_id: banfield.id, role: 'cashier', pin: '2222' },
    { id: 'u_lomas_v1',name: 'Sofía',    lastname: 'Martínez',   branch_id: lomas.id,    role: 'seller',  pin: '1111' },
    { id: 'u_lomas_v2',name: 'Lucas',    lastname: 'Rodríguez',  branch_id: lomas.id,    role: 'seller',  pin: '1111' },
    { id: 'u_banf_v1', name: 'Camila',   lastname: 'López',      branch_id: banfield.id, role: 'seller',  pin: '2222' },
    { id: 'u_banf_v2', name: 'Mateo',    lastname: 'Gómez',      branch_id: banfield.id, role: 'seller',  pin: '2222' },
  ];
  for (const u of users) await put('users', u);

  // --- Config (key/value) ---
  const configs = [
    { key: 'payment_methods', value: DEFAULT_PAYMENT_METHODS },
    { key: 'credit_note_months', value: 6 },
    { key: 'company',         value: { name: 'Ingenium', cuit: '', address: '', logo: '' } },
    { key: 'low_stock_threshold', value: 3 },
  ];
  for (const c of configs) await put('config', c);

  // --- Categorías / Marcas / Proveedores ---
  const categories = [
    { id: 'cat_rc',        name: 'Remote Control' },
    { id: 'cat_edu',       name: 'Educativo' },
    { id: 'cat_peluche',   name: 'Peluches' },
    { id: 'cat_bebe',      name: 'Bebé' },
    { id: 'cat_aire_libre',name: 'Aire Libre' },
  ];
  for (const c of categories) await put('categories', c);

  const brands = [
    { id: 'br_turbo',  name: 'Turbo' },
    { id: 'br_logix',  name: 'Logix' },
    { id: 'br_softhug',name: 'SoftHug' },
    { id: 'br_mimos',  name: 'Mimos' },
    { id: 'br_parkit', name: 'ParkIt' },
  ];
  for (const b of brands) await put('brands', b);

  const suppliers = [
    { id: 'sup_1', name: 'JugueteMax SA',  cuit: '30-12345678-9', phone: '1144445555' },
    { id: 'sup_2', name: 'Importadora Sur',cuit: '30-98765432-1', phone: '1166667777' },
    { id: 'sup_3', name: 'Distribuidora Este', cuit: '30-11223344-5', phone: '1133332222' },
  ];
  for (const s of suppliers) await put('suppliers', s);

  // --- Productos (20) ---
  const mk = (i, data) => ({
    id: `prod_${String(i).padStart(3, '0')}`,
    code: data.code || `SKU-${1000 + i}`,
    name: data.name,
    cost: data.cost,
    margin_pct: data.margin_pct ?? 100,
    price: data.price ?? +(data.cost * (1 + (data.margin_pct ?? 100) / 100)).toFixed(2),
    category_id: data.category_id,
    brand_id: data.brand_id,
    supplier_id: data.supplier_id,
    subcategory_id: null,
    published_meli: data.meli || false,
    variants_count: 0,
    created_at: new Date().toISOString(),
  });

  const products = [
    mk(1,  { code: 'SKU-90210', name: 'Turbo Racer XL',         cost: 20, margin_pct: 125, category_id: 'cat_rc',      brand_id: 'br_turbo',   supplier_id: 'sup_1', meli: true }),
    mk(2,  { code: 'SKU-90211', name: 'Turbo Racer Mini',       cost: 12, margin_pct: 120, category_id: 'cat_rc',      brand_id: 'br_turbo',   supplier_id: 'sup_1' }),
    mk(3,  { code: 'SKU-88294', name: 'Logic Blocks Set',       cost: 15, margin_pct: 116, category_id: 'cat_edu',     brand_id: 'br_logix',   supplier_id: 'sup_2' }),
    mk(4,  { code: 'SKU-88295', name: 'Logic Blocks Pro',       cost: 28, margin_pct: 110, category_id: 'cat_edu',     brand_id: 'br_logix',   supplier_id: 'sup_2', meli: true }),
    mk(5,  { code: 'SKU-70001', name: 'Peluche Oso 30cm',       cost:  8, margin_pct: 125, category_id: 'cat_peluche', brand_id: 'br_softhug', supplier_id: 'sup_3' }),
    mk(6,  { code: 'SKU-70002', name: 'Peluche Conejo 40cm',    cost: 10, margin_pct: 120, category_id: 'cat_peluche', brand_id: 'br_softhug', supplier_id: 'sup_3' }),
    mk(7,  { code: 'SKU-70003', name: 'Peluche Jirafa Gigante', cost: 25, margin_pct: 100, category_id: 'cat_peluche', brand_id: 'br_softhug', supplier_id: 'sup_3' }),
    mk(8,  { code: 'SKU-60100', name: 'Sonajero Musical',       cost:  6, margin_pct: 150, category_id: 'cat_bebe',    brand_id: 'br_mimos',   supplier_id: 'sup_3' }),
    mk(9,  { code: 'SKU-60101', name: 'Gimnasio para Bebé',     cost: 22, margin_pct: 110, category_id: 'cat_bebe',    brand_id: 'br_mimos',   supplier_id: 'sup_3' }),
    mk(10, { code: 'SKU-60102', name: 'Mordillo Refrigerado',   cost:  4, margin_pct: 200, category_id: 'cat_bebe',    brand_id: 'br_mimos',   supplier_id: 'sup_3' }),
    mk(11, { code: 'SKU-50200', name: 'Pelota Pilates Niño',    cost:  7, margin_pct: 130, category_id: 'cat_aire_libre', brand_id: 'br_parkit', supplier_id: 'sup_1' }),
    mk(12, { code: 'SKU-50201', name: 'Soga Saltar Multicolor', cost:  3, margin_pct: 200, category_id: 'cat_aire_libre', brand_id: 'br_parkit', supplier_id: 'sup_1' }),
    mk(13, { code: 'SKU-50202', name: 'Aro Hula-Hula',          cost:  5, margin_pct: 180, category_id: 'cat_aire_libre', brand_id: 'br_parkit', supplier_id: 'sup_1' }),
    mk(14, { code: 'SKU-50203', name: 'Globo Saltarín',         cost:  9, margin_pct: 150, category_id: 'cat_aire_libre', brand_id: 'br_parkit', supplier_id: 'sup_1' }),
    mk(15, { code: 'SKU-88296', name: 'Rompecabezas 1000pz',    cost: 14, margin_pct: 115, category_id: 'cat_edu',     brand_id: 'br_logix',   supplier_id: 'sup_2' }),
    mk(16, { code: 'SKU-88297', name: 'Abaco Didáctico',        cost:  6, margin_pct: 166, category_id: 'cat_edu',     brand_id: 'br_logix',   supplier_id: 'sup_2' }),
    mk(17, { code: 'SKU-90212', name: 'Drone Principiante',     cost: 45, margin_pct:  85, category_id: 'cat_rc',      brand_id: 'br_turbo',   supplier_id: 'sup_1', meli: true }),
    mk(18, { code: 'SKU-90213', name: 'Helicóptero RC',         cost: 35, margin_pct:  95, category_id: 'cat_rc',      brand_id: 'br_turbo',   supplier_id: 'sup_1' }),
    mk(19, { code: 'SKU-70004', name: 'Peluche Perro Pequeño',  cost:  5, margin_pct: 160, category_id: 'cat_peluche', brand_id: 'br_softhug', supplier_id: 'sup_3' }),
    mk(20, { code: 'SKU-60103', name: 'Móvil Musical Cuna',     cost: 18, margin_pct: 120, category_id: 'cat_bebe',    brand_id: 'br_mimos',   supplier_id: 'sup_3' }),
  ];
  for (const p of products) await put('products', p);

  // --- Stock inicial (distribuido entre las 2 sucursales) ---
  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    const qtyLomas    = 3 + (i % 5);
    const qtyBanfield = 2 + ((i + 2) % 5);
    await put('stock', { id: stockId(p.id, lomas.id),    product_id: p.id, branch_id: lomas.id,    qty: qtyLomas,    reserved_qty: i === 0 ? 1 : 0 });
    await put('stock', { id: stockId(p.id, banfield.id), product_id: p.id, branch_id: banfield.id, qty: qtyBanfield, reserved_qty: 0 });
  }

  // --- Clientes ---
  const customers = [
    { id: 'cus_1', name: 'María',   lastname: 'Perez',    email: 'maria@ejemplo.com', phone: '1122223333', birthday: '1988-07-15', created_at: new Date().toISOString() },
    { id: 'cus_2', name: 'Juan',    lastname: 'Gonzalez', email: '',                  phone: '1155556666', birthday: '1975-03-22', created_at: new Date().toISOString() },
    { id: 'cus_3', name: 'Lucía',   lastname: 'Alvarez',  email: 'lu@ejemplo.com',    phone: '',          birthday: '',           created_at: new Date().toISOString() },
  ];
  for (const c of customers) await put('customers', c);

  // --- Empleados ---
  const employees = [
    { id: 'emp_1', name: 'Lucas',  lastname: 'Rodriguez', branch_id: lomas.id,    hourly_rate: 3500, monthly_salary: null, active: true, created_at: new Date().toISOString() },
    { id: 'emp_2', name: 'Sofia',  lastname: 'Martinez',  branch_id: lomas.id,    hourly_rate: 3200, monthly_salary: null, active: true, created_at: new Date().toISOString() },
    { id: 'emp_3', name: 'Mateo',  lastname: 'Gomez',     branch_id: banfield.id, hourly_rate: 3500, monthly_salary: null, active: true, created_at: new Date().toISOString() },
    { id: 'emp_4', name: 'Camila', lastname: 'Lopez',     branch_id: banfield.id, hourly_rate: 3200, monthly_salary: null, active: true, created_at: new Date().toISOString() },
  ];
  for (const e of employees) await put('employees', e);

  // --- Contadores correlativos ---
  await put('counters', { name: 'sale_number',     value: 0 });
  await put('counters', { name: 'return_number',   value: 0 });
  await put('counters', { name: 'transfer_number', value: 0 });
  await put('counters', { name: 'credit_note',     value: 0 });

  // --- Apertura de caja inicial ambas sucursales ---
  const openingLomas    = { id: newId('cm'), type: 'opening', datetime: new Date().toISOString(), branch_id: lomas.id,    amount_in: 5000, amount_out: 0, balance_after: 5000, user_id: 'u_admin', description: 'Apertura inicial (seed)' };
  const openingBanfield = { id: newId('cm'), type: 'opening', datetime: new Date().toISOString(), branch_id: banfield.id, amount_in: 5000, amount_out: 0, balance_after: 5000, user_id: 'u_admin', description: 'Apertura inicial (seed)' };
  await put('cash_movements', openingLomas);
  await put('cash_movements', openingBanfield);

  return true;
}
