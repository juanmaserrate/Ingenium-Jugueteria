import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getStock, setStock, adjustStock, transferStock } from '../services/stock.js';

const setSchema = z.object({
  variantId: z.string(),
  branchId: z.string(),
  qty: z.number().int().min(0),
  reason: z.string().optional(),
});

const adjustSchema = z.object({
  variantId: z.string(),
  branchId: z.string(),
  delta: z.number().int(),
  reason: z.string().optional(),
});

const transferSchema = z.object({
  variantId: z.string(),
  fromBranch: z.string(),
  toBranch: z.string(),
  qty: z.number().int().positive(),
});

export async function stockRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/stock/:variantId/:branchId', async (req) => {
    const { variantId, branchId } = req.params as any;
    return getStock(variantId, branchId);
  });

  app.post('/stock/set', async (req) => {
    const body = setSchema.parse(req.body);
    return setStock(body.variantId, body.branchId, body.qty, {
      userId: req.user.userId,
      reason: body.reason,
    });
  });

  app.post('/stock/adjust', async (req) => {
    const body = adjustSchema.parse(req.body);
    return adjustStock(body.variantId, body.branchId, body.delta, {
      userId: req.user.userId,
      reason: body.reason,
    });
  });

  app.post('/stock/transfer', async (req, reply) => {
    const body = transferSchema.parse(req.body);
    await transferStock({ ...body, userId: req.user.userId });
    return reply.send({ ok: true });
  });
}
