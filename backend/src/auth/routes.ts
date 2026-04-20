import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { prisma } from '../db.js';
import { UnauthorizedError, ValidationError } from '../utils/errors.js';
import { runSeed } from '../scripts/seed.js';

const loginPinSchema = z.object({
  branchId: z.string(),
  userId: z.string(),
  pin: z.string().min(4).max(10),
});

const loginPasswordSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

// Espeja el user del frontend (IndexedDB) al backend (Postgres).
// Acepta snake_case (formato del frontend) o camelCase.
const userSyncSchema = z
  .object({
    id: z.string().min(1),
    branch_id: z.string().optional(),
    branchId: z.string().optional(),
    name: z.string(),
    lastname: z.string().optional().nullable(),
    role: z.string(),
    email: z.string().email().optional().nullable(),
    pin_salt: z.string().optional(),
    pinSalt: z.string().optional(),
    pin_hash: z.string().optional(),
    pinHash: z.string().optional(),
    pin_iters: z.number().int().optional(),
    pinIters: z.number().int().optional(),
    active: z.boolean().optional(),
  })
  .transform((u) => ({
    id: u.id,
    branchId: u.branchId ?? u.branch_id!,
    name: u.name,
    lastname: u.lastname ?? null,
    role: u.role,
    email: u.email ?? null,
    pinSalt: u.pinSalt ?? u.pin_salt,
    pinHash: u.pinHash ?? u.pin_hash,
    pinIters: u.pinIters ?? u.pin_iters,
    active: u.active ?? true,
  }))
  .refine((u) => !!u.branchId, { message: 'branchId required' })
  .refine((u) => !!u.pinSalt && !!u.pinHash && !!u.pinIters, {
    message: 'pinSalt/pinHash/pinIters required (usar derivePin en el frontend)',
  });

export async function authRoutes(app: FastifyInstance) {
  // Login con PIN (mismo flujo que el frontend actual)
  app.post('/auth/login-pin', async (request) => {
    const { branchId, userId, pin } = loginPinSchema.parse(request.body);
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.branchId !== branchId || !user.active) {
      throw new UnauthorizedError('Usuario o sucursal incorrectos');
    }
    const derived = await pbkdf2(pin, user.pinSalt, user.pinIters);
    if (derived !== user.pinHash) throw new UnauthorizedError('PIN incorrecto');

    const token = app.jwt.sign({ userId: user.id, branchId: user.branchId, role: user.role });
    return { token, user: { id: user.id, name: user.name, role: user.role, branchId: user.branchId } };
  });

  // Login cl\u00e1sico email+password (para admin del panel integraciones)
  app.post('/auth/login', async (request) => {
    const { email, password } = loginPasswordSchema.parse(request.body);
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.passwordHash || !user.active) {
      throw new UnauthorizedError('Credenciales inv\u00e1lidas');
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new UnauthorizedError('Credenciales inv\u00e1lidas');

    const token = app.jwt.sign({ userId: user.id, branchId: user.branchId, role: user.role });
    return { token, user: { id: user.id, name: user.name, role: user.role, branchId: user.branchId } };
  });

  app.get('/auth/me', { preHandler: [app.authenticate] }, async (request) => {
    const payload = request.user;
    const user = await prisma.user.findUnique({ where: { id: payload.userId } });
    if (!user) throw new UnauthorizedError();
    return { id: user.id, name: user.name, role: user.role, branchId: user.branchId };
  });

  app.get('/auth/branches', async () => {
    return prisma.branch.findMany({ orderBy: { name: 'asc' } });
  });

  app.get('/auth/branches/:id/users', async (request) => {
    const { id } = request.params as { id: string };
    return prisma.user.findMany({
      where: { branchId: id, active: true },
      select: { id: true, name: true, lastname: true, role: true },
      orderBy: { name: 'asc' },
    });
  });

  // Sync de usuario desde el frontend: crea/actualiza en Postgres para que el
  // login por PIN siga funcionando contra el backend cuando el admin edita
  // usuarios o PINs desde Configuración.
  app.post('/auth/users/sync', { preHandler: [app.authenticate] }, async (request) => {
    if (request.user.role !== 'admin') throw new UnauthorizedError('Solo admin');
    const u = userSyncSchema.parse(request.body);
    const branch = await prisma.branch.findUnique({ where: { id: u.branchId } });
    if (!branch) throw new ValidationError(`Sucursal ${u.branchId} no existe`);
    const saved = await prisma.user.upsert({
      where: { id: u.id },
      create: {
        id: u.id,
        branchId: u.branchId,
        name: u.name,
        lastname: u.lastname,
        role: u.role,
        email: u.email,
        pinSalt: u.pinSalt!,
        pinHash: u.pinHash!,
        pinIters: u.pinIters!,
        active: u.active,
      },
      update: {
        branchId: u.branchId,
        name: u.name,
        lastname: u.lastname,
        role: u.role,
        email: u.email,
        pinSalt: u.pinSalt!,
        pinHash: u.pinHash!,
        pinIters: u.pinIters!,
        active: u.active,
      },
      select: { id: true, branchId: true, name: true, role: true, active: true },
    });
    return { ok: true, user: saved };
  });

  app.post('/auth/users/:id/deactivate', { preHandler: [app.authenticate] }, async (request) => {
    if (request.user.role !== 'admin') throw new UnauthorizedError('Solo admin');
    const { id } = request.params as { id: string };
    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) return { ok: true, skipped: 'not_found' };
    await prisma.user.update({ where: { id }, data: { active: false } });
    return { ok: true };
  });

  // Bootstrap idempotente protegido por BOOTSTRAP_TOKEN.
  // Crea sucursales + admin si no existen. Seguro correrlo N veces.
  app.post('/auth/bootstrap', async (request, reply) => {
    const expected = process.env.BOOTSTRAP_TOKEN;
    if (!expected) return reply.status(503).send({ error: 'BOOTSTRAP_TOKEN not configured' });
    const header = request.headers['x-bootstrap-token'];
    if (header !== expected) throw new UnauthorizedError('Invalid bootstrap token');
    const result = await runSeed();
    return { ok: true, ...result };
  });
}

async function pbkdf2(pin: string, salt: string, iterations: number): Promise<string> {
  const { pbkdf2: pbk } = await import('node:crypto');
  return new Promise((resolve, reject) => {
    pbk(pin, salt, iterations, 32, 'sha256', (err, key) => {
      if (err) reject(err);
      else resolve(key.toString('hex'));
    });
  });
}
