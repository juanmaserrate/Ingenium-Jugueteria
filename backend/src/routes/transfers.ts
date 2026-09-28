import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { listTransfers, createTransfer, importTransferRecord } from '../services/transfers.js';

const schema = z.object({
  fromBranch: z.string(),
  toBranch: z.string(),
  items: z.array(z.object({ variantId: z.string(), qty: z.number().int().positive() }).passthrough()).min(1),
  notes: z.string().nullable().optional(),
});

export async function transfersRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/transfers', async () => listTransfers());

  app.post('/transfers', async (req) => {
    const body = schema.parse(req.body);
    return createTransfer({ ...body, userId: req.user.userId });
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
