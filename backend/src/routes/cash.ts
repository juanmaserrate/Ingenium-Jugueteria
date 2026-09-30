import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertBranchAccess } from '../auth/jwt.js';
import { balance, openDay, closeDay, addExpense, move, listMovements, listExpenses, dayStatus,
  safeBalance, listSafeMovements, depositToSafe, withdrawFromSafe, addSafeExpense, adjustSafeBalance } from '../services/cash.js';

export async function cashRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/cash/:branchId/balance', async (req) => {
    const { branchId } = req.params as { branchId: string };
    assertBranchAccess(req.user, branchId);
    return { balance: await balance(branchId) };
  });

  app.get('/cash/:branchId/movements', async (req) => {
    const { branchId } = req.params as { branchId: string };
    assertBranchAccess(req.user, branchId);
    return listMovements(branchId);
  });

  app.get('/cash/:branchId/expenses', async (req) => {
    const { branchId } = req.params as { branchId: string };
    assertBranchAccess(req.user, branchId);
    return listExpenses(branchId);
  });

  app.get('/cash/:branchId/status', async (req) => {
    const { branchId } = req.params as { branchId: string };
    assertBranchAccess(req.user, branchId);
    return dayStatus(branchId);
  });

  app.post('/cash/open', async (req) => {
    const body = z.object({ branchId: z.string(), initialAmount: z.number() }).parse(req.body);
    assertBranchAccess(req.user, body.branchId);
    return openDay(body.branchId, body.initialAmount, req.user.userId);
  });

  app.post('/cash/close', async (req) => {
    const body = z.object({ branchId: z.string(), countedAmount: z.number() }).parse(req.body);
    assertBranchAccess(req.user, body.branchId);
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
    assertBranchAccess(req.user, body.branchId);
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
    assertBranchAccess(req.user, body.branchId);
    return move({ ...body, userId: req.user.userId });
  });

  // ===== Caja de seguridad (fuerte) =====
  app.get('/cash/:branchId/safe/balance', async (req) => {
    const { branchId } = req.params as { branchId: string };
    assertBranchAccess(req.user, branchId);
    return { balance: await safeBalance(branchId) };
  });
  app.get('/cash/:branchId/safe/movements', async (req) => {
    const { branchId } = req.params as { branchId: string };
    assertBranchAccess(req.user, branchId);
    return listSafeMovements(branchId);
  });
  app.post('/cash/:branchId/safe/deposit', async (req) => {
    const { branchId } = req.params as { branchId: string };
    assertBranchAccess(req.user, branchId);
    const body = z.object({ amount: z.number().positive(), description: z.string().optional() }).parse(req.body);
    return depositToSafe({ branchId, ...body, userId: req.user.userId });
  });
  app.post('/cash/:branchId/safe/withdraw', async (req) => {
    const { branchId } = req.params as { branchId: string };
    assertBranchAccess(req.user, branchId);
    const body = z.object({ amount: z.number().positive(), description: z.string().optional() }).parse(req.body);
    return withdrawFromSafe({ branchId, ...body, userId: req.user.userId });
  });
  app.post('/cash/:branchId/safe/expense', async (req) => {
    const { branchId } = req.params as { branchId: string };
    assertBranchAccess(req.user, branchId);
    const body = z.object({ amount: z.number().positive(), category: z.string().optional(), description: z.string().optional() }).parse(req.body);
    return addSafeExpense({ branchId, ...body, userId: req.user.userId });
  });
  app.post('/cash/:branchId/safe/adjust', async (req) => {
    const { branchId } = req.params as { branchId: string };
    assertBranchAccess(req.user, branchId);
    const body = z.object({ targetBalance: z.number(), description: z.string().optional() }).parse(req.body);
    return adjustSafeBalance({ branchId, ...body, userId: req.user.userId });
  });
}
