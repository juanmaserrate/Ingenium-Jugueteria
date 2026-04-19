import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { confirmSale, cancelSale, listSales, getSale } from '../services/sales.js';

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
    const q = req.query as { branchId?: string; limit?: string };
    return listSales({ branchId: q.branchId, limit: q.limit ? parseInt(q.limit) : undefined });
  });

  app.get('/sales/:id', async (req) => {
    const { id } = req.params as { id: string };
    return getSale(id);
  });

  app.post('/sales', async (req) => {
    const body = saleSchema.parse(req.body);
    return confirmSale(body, { userId: req.user.userId, allowNegative: body.allowNegative });
  });

  app.post('/sales/:id/cancel', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ reason: z.string().optional() }).parse(req.body ?? {});
    await cancelSale(id, { userId: req.user.userId, reason: body.reason });
    return reply.send({ ok: true });
  });

  // Batch sync from offline queue (frontend envia ventas acumuladas)
  app.post('/sales/batch', async (req) => {
    const body = z.array(saleSchema).parse(req.body);
    const results: any[] = [];
    for (const s of body) {
      try {
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
