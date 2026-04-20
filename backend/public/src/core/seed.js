// Estructura inicial (factory reset): sucursales + un usuario por sucursal + config base.
// Se corre una vez si la DB está vacía (o desde Configuración → Reiniciar sistema).
// NO incluye productos, clientes, empleados ni movimientos: el dueño carga todo desde el sistema.

import { put, count, clear } from './db.js';
import { STORES } from './schema.js';

// Métodos de pago por defecto (editables desde Configuración).
const DEFAULT_PAYMENT_METHODS = [
  { id: 'cash',       name: 'Efectivo',          affects_cash: true,  icon: 'payments' },
  { id: 'card_debit', name: 'Tarjeta de Débito', affects_cash: false, icon: 'credit_card' },
  { id: 'card_credit',name: 'Tarjeta de Crédito',affects_cash: false, icon: 'credit_card' },
  { id: 'transfer',   name: 'Transferencia',     affects_cash: false, icon: 'account_balance' },
  { id: 'mercadopago',name: 'MercadoPago',       affects_cash: false, icon: 'qr_code' },
  { id: 'credit_note',name: 'Vale',              affects_cash: false, icon: 'confirmation_number' },
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

  // --- Usuarios iniciales ---
  // Uno por sucursal, ambos admin para que puedan configurar todo desde Settings.
  // PINs temporales — cambiarlos desde Configuración → Usuarios al primer uso real.
  const users = [
    { id: 'u_lomas',    name: 'Lomas',    lastname: '', branch_id: lomas.id,    role: 'admin', pin: '1111' },
    { id: 'u_banfield', name: 'Banfield', lastname: '', branch_id: banfield.id, role: 'admin', pin: '2222' },
  ];
  for (const u of users) await put('users', u);

  // --- Config base (editable) ---
  const configs = [
    { key: 'payment_methods',     value: DEFAULT_PAYMENT_METHODS },
    { key: 'credit_note_months',  value: 6 },
    { key: 'company',             value: { name: 'Ingenium', cuit: '', address: '', logo: '' } },
    { key: 'low_stock_threshold', value: 3 },
  ];
  for (const c of configs) await put('config', c);

  // --- Contadores correlativos (arrancan en 0) ---
  await put('counters', { name: 'sale_number',     value: 0 });
  await put('counters', { name: 'return_number',   value: 0 });
  await put('counters', { name: 'transfer_number', value: 0 });
  await put('counters', { name: 'credit_note',     value: 0 });

  return true;
}
