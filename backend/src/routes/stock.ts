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

  // Descuento masivo de stock (histórico) SIN sincronizar a Tienda Nube.
  // Uso puntual: cargar ventas que ya fueron descontadas en TN, para que el
  // stock local coincida sin volver a descontarlas online. Clampa en 0.
  app.post('/stock/bulk-discount', async (req) => {
    const body = z.object({
      reason: z.string().optional(),
      items: z.array(z.object({
        variantId: z.string(),
        branchId: z.string(),
        qty: z.number().int().positive(),
      })).min(1),
    }).parse(req.body);
    const results: any[] = [];
    for (const it of body.items) {
      try {
        const cur = await getStock(it.variantId, it.branchId);
        const before = cur?.qty ?? 0;
        const applied = Math.min(it.qty, Math.max(0, before)); // no bajar de 0
        const newQty = Math.max(0, before - it.qty);
        await setStock(it.variantId, it.branchId, newQty, {
          userId: req.user.userId,
          reason: body.reason ?? 'Descuento ventas (histórico, sin push a TN)',
          skipTnSync: true,
        });
        results.push({ variantId: it.variantId, branchId: it.branchId, before, requested: it.qty, applied, newQty, clamped: it.qty > before });
      } catch (e: any) {
        results.push({ variantId: it.variantId, branchId: it.branchId, error: e?.message ?? String(e) });
      }
    }
    return { count: results.filter((r) => !r.error).length, results };
  });
}
