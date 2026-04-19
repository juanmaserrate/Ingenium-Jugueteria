import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { processReturn, listReturns } from '../services/returns.js';

const itemSchema = z.object({
  variantId: z.string(),
  qty: z.number().int().positive(),
  unitPrice: z.number().nonnegative(),
});

const schema = z.object({
  branchId: z.string(),
  originalSaleId: z.string().nullable().optional(),
  customerId: z.string().nullable().optional(),
  returnedItems: z.array(itemSchema),
  takenItems: z.array(itemSchema),
  refundPayments: z.array(z.object({
    methodId: z.string(),
    methodName: z.string(),
    amount: z.number(),
  })).optional(),
  emitCreditNote: z.boolean().optional(),
  reason: z.string().optional(),
});

export async function returnsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/returns', async (req) => {
    const q = req.query as { branchId?: string };
    return listReturns({ branchId: q.branchId });
  });

  app.post('/returns', async (req) => {
    const body = schema.parse(req.body);
    return processReturn({ ...body, userId: req.user.userId });
  });
}
