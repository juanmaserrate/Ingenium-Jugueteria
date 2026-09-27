import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { listSenas, createSena, getSenaByNumber, cancelSena } from '../services/senas.js';

const createSchema = z.object({
  customerId: z.string(),
  amount: z.number().positive(),
  branchId: z.string(),
  methodId: z.string().nullable().optional(),
  methodName: z.string().nullable().optional(),
  affectsCash: z.boolean().optional(),
  note: z.string().nullable().optional(),
});

export async function senasRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/senas', async (req) => {
    const q = req.query as { customerId?: string; status?: string };
    return listSenas({ customerId: q.customerId, status: q.status });
  });

  app.get('/senas/by-number/:number', async (req) => {
    const { number } = req.params as { number: string };
    return (await getSenaByNumber(Number(number))) ?? null;
  });

  app.post('/senas', async (req) => {
    const body = createSchema.parse(req.body);
    return createSena({ ...body, userId: req.user.userId });
  });

  app.post('/senas/:id/cancel', async (req, reply) => {
    const { id } = req.params as { id: string };
    await cancelSena(id, req.user.userId);
    return reply.send({ ok: true });
  });
}
