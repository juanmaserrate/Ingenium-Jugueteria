import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { confirmSale, cancelSale, listSales, getSale } from '../services/sales.js';
import { assertBranchAccess } from '../auth/jwt.js';

const itemSchema = z.object({
  variantId: z.string(),
  qty: z.number().int().positive(),
  unitPrice: z.number().nonnegative(),
  discountPct: z.number().nullable().optional(),
  discountFixed: z.number().nullable().optional(),
  priceOverridden: z.boolean().optional(),
});

const paymentSchema = z.object({
  methodId: z.string(),
  methodName: z.string(),
  amount: z.number(),
  affectsCash: z.boolean().optional(),
  senaId: z.string().nullable().optional(),
  creditNoteId: z.string().nullable().optional(),
});

const saleSchema = z.object({
  id: z.string().optional(),
  branchId: z.string(),
  sellerId: z.string().nullable().optional(),
  customerId: z.string().nullable().optional(),
  items: z.array(itemSchema).min(1),
  payments: z.array(paymentSchema).min(1),
  discountGlobalPct: z.number().nullable().optional(),
  discountGlobalFixed: z.number().nullable().optional(),
  surchargeGlobalPct: z.number().nullable().optional(),
  surchargeGlobalFixed: z.number().nullable().optional(),
  source: z.enum(['pos', 'tn']).optional(),
  tnOrderId: z.string().nullable().optional(),
  offlineId: z.string().nullable().optional(),
  datetime: z.coerce.date().optional(),
  allowNegative: z.boolean().optional(),
});

export async function salesRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/sales', async (req) => {
    const q = req.query as { branchId?: string; limit?: string; from?: string; to?: string; status?: string; source?: string; customerId?: string };
    // No-admin: se acota a SU sucursal (ignora cualquier branchId que venga).
    const branchId = req.user.role === 'admin' ? q.branchId : req.user.branchId;
    return listSales({
      branchId, limit: q.limit ? parseInt(q.limit) : undefined,
      from: q.from, to: q.to, status: q.status, source: q.source, customerId: q.customerId,
    });
  });

  app.get('/sales/:id', async (req) => {
    const { id } = req.params as { id: string };
    const sale = await getSale(id);
    assertBranchAccess(req.user, sale.branchId);
    return sale;
  });

  app.post('/sales', async (req) => {
    const body = saleSchema.parse(req.body);
    assertBranchAccess(req.user, body.branchId);
    return confirmSale(body, { userId: req.user.userId, allowNegative: body.allowNegative });
  });

  app.post('/sales/:id/cancel', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ reason: z.string().optional(), returnToTn: z.boolean().optional() }).parse(req.body ?? {});
    const sale = await getSale(id);
    assertBranchAccess(req.user, sale.branchId);
    await cancelSale(id, { userId: req.user.userId, reason: body.reason, returnToTn: body.returnToTn });
    return reply.send({ ok: true });
  });

  // Batch sync from offline queue (frontend envia ventas acumuladas)
  app.post('/sales/batch', async (req) => {
    const body = z.array(saleSchema).parse(req.body);
    const results: any[] = [];
    for (const s of body) {
      try {
        assertBranchAccess(req.user, s.branchId);
        const sale = await confirmSale(s, { userId: req.user.userId, allowNegative: s.allowNegative });
        results.push({ ok: true, offlineId: s.offlineId, id: sale.id });
      } catch (err: any) {
        results.push({
          ok: false,
          offlineId: s.offlineId,
          error: err.message,
          code: err.code,
          details: err.details,
        });
      }
    }
    return { results };
  });
}
