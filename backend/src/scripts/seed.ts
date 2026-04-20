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
  const saltBuf = randomBytes(16);
  const saltHex = saltBuf.toString('hex');
  const iters = 120_000;
  // salt se pasa como bytes (no como hex string) para matchear el frontend.
  const hash = pbkdf2Sync(pin, saltBuf, iters, 32, 'sha256').toString('hex');
  return { pinSalt: saltHex, pinIters: iters, pinHash: hash };
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
  } else {
    // Rehash con algoritmo compatible con el frontend (salt-as-bytes).
    // Lo hacemos sólo si el hash actual no valida con el algoritmo nuevo
    // para no tocar admins cuyo PIN haya sido cambiado manualmente.
    const saltBuf = Buffer.from(existingAdmin.pinSalt, 'hex');
    const expected = pbkdf2Sync(DEFAULT_ADMIN.pin, saltBuf, existingAdmin.pinIters, 32, 'sha256').toString('hex');
    if (expected !== existingAdmin.pinHash) {
      const pin = hashPin(DEFAULT_ADMIN.pin);
      await prisma.user.update({
        where: { id: DEFAULT_ADMIN.id },
        data: { pinSalt: pin.pinSalt, pinHash: pin.pinHash, pinIters: pin.pinIters },
      });
    }
  }

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
    // Rehash si el PIN por defecto ya no valida con el algoritmo nuevo.
    const saltBuf = Buffer.from(existing.pinSalt, 'hex');
    const expected = pbkdf2Sync(u.pin, saltBuf, existing.pinIters, 32, 'sha256').toString('hex');
    if (expected !== existing.pinHash) {
      const pin = hashPin(u.pin);
      await prisma.user.update({
        where: { id: u.id },
        data: { pinSalt: pin.pinSalt, pinHash: pin.pinHash, pinIters: pin.pinIters },
      });
      frontendUsersRehashed.push(u.id);
    }
  }

  return {
    branches: BRANCHES.map((b) => b.id),
    adminCreated: !existingAdmin,
    adminEmail: DEFAULT_ADMIN.email,
    adminPin: !existingAdmin ? DEFAULT_ADMIN.pin : '(ya existia)',
    adminPassword: !existingAdmin ? DEFAULT_ADMIN.password : '(ya existia)',
    frontendUsersCreated,
    frontendUsersRehashed,
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
