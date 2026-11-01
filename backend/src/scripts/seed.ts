import { pbkdf2Sync, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../db.js';

// El sistema usa SIEMPRE los ids con prefijo br_ (los que genera el seed del frontend).
const BRANCHES = [
  { id: 'br_lomas',    name: 'Lomas',    address: 'Lomas de Zamora' },
  { id: 'br_banfield', name: 'Banfield', address: 'Banfield' },
];

// Sucursales legacy (sin prefijo) que un seed viejo creó duplicadas. Se limpian al arrancar.
const LEGACY_BRANCHES = [
  { id: 'lomas',    to: 'br_lomas' },
  { id: 'banfield', to: 'br_banfield' },
];

const DEFAULT_ADMIN = {
  id: 'admin',
  branchId: 'br_lomas',
  name: 'Admin',
  lastname: 'Ingenium',
  role: 'admin',
  email: 'admin@ingenium.local',
  pin: '1234',
  password: 'Ingenium2026!',
};

// Usuarios que matchean con el seed local del frontend (IndexedDB).
// Permiten que el login por PIN obtenga un JWT válido del backend.
const FRONTEND_USERS = [
  { id: 'u_lomas',    branchId: 'br_lomas',    name: 'Lomas',    lastname: '', role: 'manager', pin: '1111' },
  { id: 'u_banfield', branchId: 'br_banfield', name: 'Banfield', lastname: '', role: 'manager', pin: '2222' },
];

function hashPin(pin: string) {
  const saltBuf = randomBytes(16);
  const saltHex = saltBuf.toString('hex');
  const iters = 120_000;
  // salt se pasa como bytes (no como hex string) para matchear el frontend.
  const hash = pbkdf2Sync(pin, saltBuf, iters, 32, 'sha256').toString('hex');
  return { pinSalt: saltHex, pinIters: iters, pinHash: hash };
}

export async function runSeed() {
  // Migración idempotente: el schema de prod se sincroniza por fuera (db push).
  // Esto garantiza que la columna multi-sucursal de empleados exista sin depender
  // de ese paso y sin perder datos (ADD COLUMN IF NOT EXISTS es no-op si ya está).
  try {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "branch_ids" JSONB NOT NULL DEFAULT '[]'::jsonb`,
    );
  } catch (err) {
    console.warn('[seed] no se pudo asegurar employees.branch_ids:', err);
  }
  // Snapshot del vendedor en la venta (el POS lo manda como nombre; ver sales.ts).
  try {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "seller_name" TEXT`,
    );
  } catch (err) {
    console.warn('[seed] no se pudo asegurar sales.seller_name:', err);
  }
  // Snapshot de costos por pago (promo/comisión/financiero/neto). Ver módulo de promos.
  try {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "sale_payments" ADD COLUMN IF NOT EXISTS "cost_meta" JSONB`,
    );
  } catch (err) {
    console.warn('[seed] no se pudo asegurar sale_payments.cost_meta:', err);
  }
  // Mercado Libre: columnas de refresh token / expiración / seller id en integrations
  // (el access token de ML expira y hay refresh token de un solo uso; TN no las usa).
  try {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "refresh_token_enc" TEXT`,
    );
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "token_expires_at" TIMESTAMP(3)`,
    );
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "ml_user_id" TEXT`,
    );
  } catch (err) {
    console.warn('[seed] no se pudo asegurar columnas ML en integrations:', err);
  }
  // Tabla de fotos mensuales de stock (db push no la crea de forma confiable acá;
  // la creamos idempotente al arrancar). Debe coincidir con el modelo StockSnapshot.
  try {
    await prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "stock_snapshot" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "period_key" TEXT NOT NULL,
        "variant_id" TEXT NOT NULL,
        "branch_id" TEXT NOT NULL,
        "qty" INTEGER NOT NULL,
        "taken_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS "stock_snapshot_period_key_variant_id_branch_id_key" ON "stock_snapshot" ("period_key","variant_id","branch_id")`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "stock_snapshot_period_key_idx" ON "stock_snapshot" ("period_key")`,
    );
  } catch (err) {
    console.warn('[seed] no se pudo asegurar stock_snapshot:', err);
  }

  for (const b of BRANCHES) {
    await prisma.branch.upsert({
      where:  { id: b.id },
      update: { name: b.name, address: b.address },
      create: b,
    });
  }

  const existingAdmin = await prisma.user.findUnique({ where: { id: DEFAULT_ADMIN.id } });
  if (!existingAdmin) {
    const pin = hashPin(DEFAULT_ADMIN.pin);
    const passwordHash = await bcrypt.hash(DEFAULT_ADMIN.password, 10);
    await prisma.user.create({
      data: {
        id: DEFAULT_ADMIN.id,
        branchId: DEFAULT_ADMIN.branchId,
        name: DEFAULT_ADMIN.name,
        lastname: DEFAULT_ADMIN.lastname,
        role: DEFAULT_ADMIN.role,
        email: DEFAULT_ADMIN.email,
        pinSalt: pin.pinSalt,
        pinHash: pin.pinHash,
        pinIters: pin.pinIters,
        passwordHash,
        active: true,
      },
    });
  }
  // Admin EXISTENTE: no se toca. Antes había un "rehash" que, si el PIN no coincidía
  // con el default '1234', lo reescribía al default — y eso pisaba en CADA arranque el PIN
  // que el usuario hubiera cambiado (bug: reseteaba 'genio' → '1234' en cada deploy).
  // La migración de algoritmo (salt-as-bytes) ya corrió hace tiempo; el seed solo crea
  // el admin si falta y nunca reescribe su PIN/rol/nombre.

  const frontendUsersCreated: string[] = [];
  const frontendUsersRehashed: string[] = [];
  for (const u of FRONTEND_USERS) {
    const existing = await prisma.user.findUnique({ where: { id: u.id } });
    if (!existing) {
      const pin = hashPin(u.pin);
      await prisma.user.create({
        data: {
          id: u.id,
          branchId: u.branchId,
          name: u.name,
          lastname: u.lastname,
          role: u.role,
          pinSalt: pin.pinSalt,
          pinHash: pin.pinHash,
          pinIters: pin.pinIters,
          active: true,
        },
      });
      frontendUsersCreated.push(u.id);
      continue;
    }
    // Usuario EXISTENTE (encargado): no se toca su PIN ni su rol. Antes se reescribía al
    // default (1111/2222) en cada arranque si no coincidía → pisaba PINs/roles cambiados.
  }

  const legacyCleaned = await cleanupLegacyBranches();

  return {
    branches: BRANCHES.map((b) => b.id),
    adminCreated: !existingAdmin,
    adminEmail: DEFAULT_ADMIN.email,
    adminPin: !existingAdmin ? DEFAULT_ADMIN.pin : '(ya existia)',
    adminPassword: !existingAdmin ? DEFAULT_ADMIN.password : '(ya existia)',
    frontendUsersCreated,
    frontendUsersRehashed,
    legacyCleaned,
  };
}

/**
 * Elimina las sucursales legacy duplicadas ('lomas'/'banfield') que un seed viejo
 * creó junto a las br_*. Idempotente: reasigna lo que dependa de ellas a la br_
 * correspondiente y luego borra. Si quedan dependencias raras (FK), no rompe el
 * arranque — registra el error y deja la branch para revisión manual.
 */
async function cleanupLegacyBranches(): Promise<string[]> {
  const cleaned: string[] = [];
  for (const { id, to } of LEGACY_BRANCHES) {
    const exists = await prisma.branch.findUnique({ where: { id } });
    if (!exists) continue;
    try {
      // Reasignar referencias conocidas a la sucursal br_ correcta.
      await prisma.user.updateMany({ where: { branchId: id }, data: { branchId: to } });
      await prisma.sale.updateMany({ where: { branchId: id }, data: { branchId: to } });
      await prisma.return.updateMany({ where: { branchId: id }, data: { branchId: to } });
      await prisma.cashMovement.updateMany({ where: { branchId: id }, data: { branchId: to } });
      await prisma.expense.updateMany({ where: { branchId: id }, data: { branchId: to } });
      await prisma.purchase.updateMany({ where: { branchId: id }, data: { branchId: to } });
      await prisma.employee.updateMany({ where: { branchId: id }, data: { branchId: to } });
      await prisma.notification.updateMany({ where: { branchId: id }, data: { branchId: to } });
      // Stock y transfers usan composite/relaciones más complejas: si hay, el delete fallará
      // y lo dejamos para revisión (no debería haber: el front siempre usó br_*).
      await prisma.branch.delete({ where: { id } });
      cleaned.push(id);
    } catch (err) {
      console.warn(`No se pudo limpiar la sucursal legacy '${id}':`, (err as Error).message);
    }
  }
  return cleaned;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSeed()
    .then((r) => {
      console.log('Seed OK:', r);
      return prisma.$disconnect();
    })
    .catch((err) => {
      console.error('Seed error:', err);
      return prisma.$disconnect().finally(() => process.exit(1));
    });
}
