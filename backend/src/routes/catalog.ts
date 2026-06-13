import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  getCatalog,
  listCategories, upsertCategory, deleteCategory,
  listSubcategories, upsertSubcategory, deleteSubcategory,
  listBrands, upsertBrand, deleteBrand,
  listSuppliers, upsertSupplier, deleteSupplier,
  bulkCreateSuppliers,
} from '../services/catalog.js';

const nameSchema = z.object({ id: z.string().optional(), name: z.string().min(1) });
const subSchema = z.object({ id: z.string().optional(), name: z.string().min(1), categoryId: z.string().nullable().optional() });
const supplierSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  phone: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  cuit: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

export async function catalogRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  // Catálogo completo (sync inicial del front)
  app.get('/catalog', async () => getCatalog());

  // Categorías
  app.get('/categories', async () => listCategories());
  app.post('/categories', async (req) => upsertCategory(nameSchema.parse(req.body), req.user.userId));
  app.put('/categories/:id', async (req) => {
    const { id } = req.params as { id: string };
    return upsertCategory({ ...nameSchema.parse(req.body), id }, req.user.userId);
  });
  app.delete('/categories/:id', async (req, reply) => {
    await deleteCategory((req.params as any).id, req.user.userId);
    return reply.status(204).send();
  });

  // Subcategorías
  app.get('/subcategories', async () => listSubcategories());
  app.post('/subcategories', async (req) => upsertSubcategory(subSchema.parse(req.body), req.user.userId));
  app.put('/subcategories/:id', async (req) => {
    const { id } = req.params as { id: string };
    return upsertSubcategory({ ...subSchema.parse(req.body), id }, req.user.userId);
  });
  app.delete('/subcategories/:id', async (req, reply) => {
    await deleteSubcategory((req.params as any).id, req.user.userId);
    return reply.status(204).send();
  });

  // Marcas
  app.get('/brands', async () => listBrands());
  app.post('/brands', async (req) => upsertBrand(nameSchema.parse(req.body), req.user.userId));
  app.put('/brands/:id', async (req) => {
    const { id } = req.params as { id: string };
    return upsertBrand({ ...nameSchema.parse(req.body), id }, req.user.userId);
  });
  app.delete('/brands/:id', async (req, reply) => {
    await deleteBrand((req.params as any).id, req.user.userId);
    return reply.status(204).send();
  });

  // Proveedores
  app.get('/suppliers', async () => listSuppliers());
  app.post('/suppliers', async (req) => upsertSupplier(supplierSchema.parse(req.body), req.user.userId));
  app.put('/suppliers/:id', async (req) => {
    const { id } = req.params as { id: string };
    return upsertSupplier({ ...supplierSchema.parse(req.body), id }, req.user.userId);
  });
  app.delete('/suppliers/:id', async (req, reply) => {
    await deleteSupplier((req.params as any).id, req.user.userId);
    return reply.status(204).send();
  });

  // Alta masiva de proveedores por nombre
  app.post('/suppliers/bulk', async (req) => {
    const { names } = z.object({ names: z.array(z.string()) }).parse(req.body);
    return bulkCreateSuppliers(names, req.user.userId);
  });
}
