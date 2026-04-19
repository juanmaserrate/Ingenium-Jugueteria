import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { balance, openDay, closeDay, addExpense, move } from '../services/cash.js';

export async function cashRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/cash/:branchId/balance', async (req) => {
    const { branchId } = req.params as { branchId: string };
    return { balance: await balance(branchId) };
  });

  app.post('/cash/open', async (req) => {
    const body = z.object({ branchId: z.string(), initialAmount: z.number() }).parse(req.body);
    return openDay(body.branchId, body.initialAmount, req.user.userId);
  });

  app.post('/cash/close', async (req) => {
    const body = z.object({ branchId: z.string(), countedAmount: z.number() }).parse(req.body);
    return closeDay(body.branchId, body.countedAmount, req.user.userId);
  });

  app.post('/cash/expense', async (req) => {
    const body = z
      .object({
        branchId: z.string(),
        amount: z.number().positive(),
        category: z.string().optional(),
        description: z.string().optional(),
        paymentMethodId: z.string().optional(),
      })
      .parse(req.body);
    return addExpense({ ...body, userId: req.user.userId });
  });

  app.post('/cash/move', async (req) => {
    const body = z
      .object({
        branchId: z.string(),
        type: z.string(),
        amountIn: z.number().optional(),
        amountOut: z.number().optional(),
        description: z.string().optional(),
      })
      .parse(req.body);
    return move({ ...body, userId: req.user.userId });
  });
}
