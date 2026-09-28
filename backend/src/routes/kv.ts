import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';

// Almacén genérico clave/valor por colección. El front guarda el objeto completo
// como value; list() devuelve los values (mismo shape que getAll() de IndexedDB).
export async function kvRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/kv/:collection', async (req) => {
    const { collection } = req.params as { collection: string };
    const rows = await prisma.kvItem.findMany({ where: { collection } });
    return rows.map((r) => r.value);
  });

  app.get('/kv/:collection/:key', async (req) => {
    const { collection, key } = req.params as { collection: string; key: string };
    const row = await prisma.kvItem.findUnique({ where: { collection_key: { collection, key } } });
    return row ? row.value : null;
  });

  app.put('/kv/:collection/:key', async (req) => {
    const { collection, key } = req.params as { collection: string; key: string };
    const { value } = z.object({ value: z.any() }).parse(req.body);
    const row = await prisma.kvItem.upsert({
      where: { collection_key: { collection, key } },
      create: { collection, key, value: value as any },
      update: { value: value as any },
    });
    return row.value;
  });

  app.delete('/kv/:collection/:key', async (req) => {
    const { collection, key } = req.params as { collection: string; key: string };
    await prisma.kvItem.deleteMany({ where: { collection, key } });
    return { ok: true };
  });
}
