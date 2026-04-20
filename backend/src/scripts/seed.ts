import { pbkdf2Sync, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../db.js';

const BRANCHES = [
  { id: 'lomas',       name: 'Lomas de Zamora', address: '' },
  { id: 'banfield',    name: 'Banfield',        address: '' },
  // Espejos con prefijo br_ para compatibilidad con el seed del frontend.
  { id: 'br_lomas',    name: 'Lomas',           address: 'Lomas de Zamora' },
  { id: 'br_banfield', name: 'Banfield',        address: 'Banfield' },
];

const DEFAULT_ADMIN = {
  id: 'admin',
  branchId: 'lomas',
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
  { id: 'u_lomas',    branchId: 'br_lomas',    name: 'Lomas',    lastname: '', role: 'admin', pin: '1111' },
  { id: 'u_banfield', branchId: 'br_banfield', name: 'Banfield', lastname: '', role: 'admin', pin: '2222' },
];

function hashPin(pin: string) {
  const salt = randomBytes(16).toString('hex');
  const iters = 120_000;
  const hash = pbkdf2Sync(pin, salt, iters, 32, 'sha256').toString('hex');
  return { pinSalt: salt, pinIters: iters, pinHash: hash };
}

export async function runSeed() {
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

  const frontendUsersCreated: string[] = [];
  for (const u of FRONTEND_USERS) {
    const existing = await prisma.user.findUnique({ where: { id: u.id } });
    if (existing) continue;
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
  }

  return {
    branches: BRANCHES.map((b) => b.id),
    adminCreated: !existingAdmin,
    adminEmail: DEFAULT_ADMIN.email,
    adminPin: !existingAdmin ? DEFAULT_ADMIN.pin : '(ya existia)',
    adminPassword: !existingAdmin ? DEFAULT_ADMIN.password : '(ya existia)',
    frontendUsersCreated,
  };
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
