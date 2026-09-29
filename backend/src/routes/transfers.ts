import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { listTransfers, createTransfer, importTransferRecord, confirmTransfer, resolveTransfer } from '../services/transfers.js';

const schema = z.object({
  fromBranch: z.string(),
  toBranch: z.string(),
  items: z.array(z.object({ variantId: z.string(), qty: z.number().int().positive() }).passthrough()).min(1),
  notes: z.string().nullable().optional(),
});

export async function transfersRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/transfers', async (req) => {
    const q = req.query as { branchId?: string; status?: string; from?: string; to?: string };
    return listTransfers({ branchId: q.branchId, status: q.status, from: q.from, to: q.to });
  });

  app.post('/transfers', async (req) => {
    const body = schema.parse(req.body);
    return createTransfer({ ...body, userId: req.user.userId });
  });

  // Confirmar recepción (la hace el destino) → recién acá se mueve el stock.
  app.post('/transfers/:id/confirm', async (req) => {
    const { id } = req.params as { id: string };
    return confirmTransfer(id, req.user.userId);
  });

  // Rechazar (destino) o cancelar (origen) una transferencia pendiente.
  app.post('/transfers/:id/reject', async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ reason: z.string().optional() }).parse(req.body ?? {});
    return resolveTransfer(id, 'rejected', { userId: req.user.userId, reason: body.reason });
  });
  app.post('/transfers/:id/cancel', async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ reason: z.string().optional() }).parse(req.body ?? {});
    return resolveTransfer(id, 'cancelled', { userId: req.user.userId, reason: body.reason });
  });

  // Importa un remito viejo SIN mover stock (migración de registros locales).
  app.post('/transfers/import', async (req) => {
    const body = z.object({
      fromBranch: z.string(),
      toBranch: z.string(),
      items: z.any(),
      notes: z.string().nullable().optional(),
      datetime: z.string().nullable().optional(),
    }).parse(req.body);
    return importTransferRecord({ ...body, userId: req.user.userId });
  });
}
