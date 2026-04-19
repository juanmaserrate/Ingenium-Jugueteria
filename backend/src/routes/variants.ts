import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { listVariants, createVariant, updateVariant, deleteVariant } from '../services/variants.js';

const schema = z.object({
  productId: z.string(),
  name: z.string(),
  attributes: z.record(z.string()).optional(),
  code: z.string().nullable().optional(),
  barcode: z.string().nullable().optional(),
  priceOverride: z.number().nullable().optional(),
  costOverride: z.number().nullable().optional(),
});

export async function variantsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/products/:productId/variants', async (req) => {
    const { productId } = req.params as { productId: string };
    return listVariants(productId);
  });

  app.post('/variants', async (req) => {
    const body = schema.parse(req.body);
    return createVariant(body, req.user.userId);
  });

  app.put('/variants/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = schema.partial().parse(req.body);
    return updateVariant(id, body, req.user.userId);
  });

  app.delete('/variants/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await deleteVariant(id, req.user.userId);
    return reply.status(204).send();
  });
}
