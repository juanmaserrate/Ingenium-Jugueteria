import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  listPurchases,
  getPurchase,
  createPurchase,
  updatePurchase,
  setPurchaseStatus,
  deletePurchase,
  autoMatch,
  receivePurchase,
} from '../services/purchases.js';
import { savePurchaseDocument, savePurchaseStagingImage } from '../storage/documents.js';

const itemSchema = z.object({
  id: z.string().optional(),
  variantId: z.string().nullable().optional(),
  productId: z.string().nullable().optional(),
  matchType: z.string().optional(),
  rawName: z.string().min(1),
  barcode: z.string().nullable().optional(),
  sku: z.string().nullable().optional(),
  qtyOrdered: z.number(),
  unitCost: z.number(),
  marginPct: z.number().optional(),
  salePrice: z.number(),
  qtyLomas: z.number().optional(),
  qtyBanfield: z.number().optional(),
  tnConfig: z.any().optional(),
  publishTn: z.boolean().optional(),
});

const headerSchema = z.object({
  branchId: z.string().min(1),
  supplierId: z.string().nullable().optional(),
  supplierName: z.string().nullable().optional(),
  invoiceType: z.enum(['A', 'X']).optional(),
  invoiceNumber: z.string().nullable().optional(),
  marginPctDefault: z.number().optional(),
  notes: z.string().nullable().optional(),
});

const updateSchema = headerSchema.partial().extend({
  branchId: z.string().optional(),
  items: z.array(itemSchema).optional(),
});

export async function purchasesRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/purchases', async (req) => {
    const { status } = req.query as { status?: string };
    return listPurchases(status);
  });

  app.get('/purchases/:id', async (req) => {
    const { id } = req.params as { id: string };
    return getPurchase(id);
  });

  app.post('/purchases', async (req) => {
    const body = headerSchema.parse(req.body);
    return createPurchase(body, req.user.userId);
  });

  app.put('/purchases/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = updateSchema.parse(req.body);
    return updatePurchase(id, body as any, req.user.userId);
  });

  app.patch('/purchases/:id/status', async (req) => {
    const { id } = req.params as { id: string };
    const { status } = z.object({ status: z.string() }).parse(req.body);
    return setPurchaseStatus(id, status, req.user.userId);
  });

  app.post('/purchases/:id/cancel', async (req) => {
    const { id } = req.params as { id: string };
    return setPurchaseStatus(id, 'cancelled', req.user.userId);
  });

  // Recepción: impacta stock + crea/actualiza productos + encola push TN.
  app.post('/purchases/:id/receive', async (req) => {
    const { id } = req.params as { id: string };
    return receivePurchase(id, req.user.userId);
  });

  // Auto-match de líneas contra variantes existentes (barcode/SKU). No persiste.
  app.post('/purchases/match', async (req) => {
    const body = z.object({
      lines: z.array(z.object({
        barcode: z.string().nullable().optional(),
        sku: z.string().nullable().optional(),
      })),
    }).parse(req.body);
    return autoMatch(body.lines);
  });

  app.delete('/purchases/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await deletePurchase(id, req.user.userId);
    return reply.status(204).send();
  });

  // Subir factura (PDF o imagen) como documento de la compra.
  app.post('/purchases/:id/documents', async (req) => {
    const { id } = req.params as { id: string };
    await getPurchase(id); // valida que exista (404 si no)
    const file = await (req as any).file();
    if (!file) throw new Error('No file uploaded');
    const buf = await file.toBuffer();
    return savePurchaseDocument(id, buf, file.mimetype ?? 'application/octet-stream', file.filename ?? 'documento');
  });

  // Imagen de producto en staging (para items que se publicarán en TN al recibir).
  app.post('/purchases/:id/staging-image', async (req) => {
    const { id } = req.params as { id: string };
    await getPurchase(id);
    const file = await (req as any).file();
    if (!file) throw new Error('No file uploaded');
    const buf = await file.toBuffer();
    return savePurchaseStagingImage(id, buf, file.mimetype ?? 'image/jpeg', file.filename ?? 'imagen');
  });
}
