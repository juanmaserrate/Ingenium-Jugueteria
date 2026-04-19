import { pbkdf2Sync, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../db.js';

const BRANCHES = [
  { id: 'lomas',    name: 'Lomas de Zamora', address: '' },
  { id: 'banfield', name: 'Banfield',        address: '' },
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

  return {
    branches: BRANCHES.map((b) => b.id),
    adminCreated: !existingAdmin,
    adminEmail: DEFAULT_ADMIN.email,
    adminPin: !existingAdmin ? DEFAULT_ADMIN.pin : '(ya existia)',
    adminPassword: !existingAdmin ? DEFAULT_ADMIN.password : '(ya existia)',
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
