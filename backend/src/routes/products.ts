import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  listProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
  findByBarcode,
} from '../services/products.js';

const variantSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  attributes: z.record(z.string()).optional(),
  code: z.string().nullable().optional(),
  barcode: z.string().nullable().optional(),
  priceOverride: z.number().nullable().optional(),
  costOverride: z.number().nullable().optional(),
  isDefault: z.boolean().optional(),
  stocks: z.array(z.object({ branchId: z.string(), qty: z.number().int() })).optional(),
});

const productSchema = z.object({
  id: z.string().optional(),
  code: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  cost: z.number().optional(),
  marginPct: z.number().optional(),
  price: z.number().optional(),
  categoryId: z.string().nullable().optional(),
  subcategoryId: z.string().nullable().optional(),
  brandId: z.string().nullable().optional(),
  supplierId: z.string().nullable().optional(),
  publishedTn: z.boolean().optional(),
  active: z.boolean().optional(),
  variants: z.array(variantSchema).optional(),
});

export async function productsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/products', async () => listProducts());

  app.get('/products/:id', async (req) => {
    const { id } = req.params as { id: string };
    return getProduct(id);
  });

  app.get('/products/barcode/:barcode', async (req) => {
    const { barcode } = req.params as { barcode: string };
    return findByBarcode(barcode) ?? null;
  });

  app.post('/products', async (req) => {
    const body = productSchema.parse(req.body);
    return createProduct(body, req.user.userId);
  });

  app.put('/products/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = productSchema.partial().parse(req.body);
    return updateProduct(id, body, req.user.userId);
  });

  app.delete('/products/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await deleteProduct(id, req.user.userId);
    return reply.status(204).send();
  });
}
