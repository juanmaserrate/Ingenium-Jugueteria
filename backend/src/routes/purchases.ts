import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole, assertBranchAccess, type JwtPayload } from '../auth/jwt.js';
import { ForbiddenError } from '../utils/errors.js';
import {
  listPurchases,
  getPurchase,
  createPurchase,
  updatePurchase,
  setPurchaseStatus,
  deletePurchase,
  autoMatch,
  receivePurchase,
  computeSuccess,
} from '../services/purchases.js';
import { savePurchaseDocument, savePurchaseStagingImage } from '../storage/documents.js';
import { scanInvoice } from '../services/invoiceScan.js';

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
  invoiceType: z.enum(['A', 'B', 'X']).optional(),
  invoiceNumber: z.string().nullable().optional(),
  marginPctDefault: z.number().optional(),
  notes: z.string().nullable().optional(),
});

const updateSchema = headerSchema.partial().extend({
  branchId: z.string().optional(),
  items: z.array(itemSchema).optional(),
});

// Quién puede EDITAR una compra:
// - admin: siempre (es quien arma la factura).
// - encargado: solo para OPERAR LA RECEPCIÓN de una compra ya pendiente, y de su
//   propia sucursal. No puede tocar un borrador (crear/armar la factura es del admin).
function assertCanEditPurchase(user: JwtPayload, purchase: { status: string; branchId: string }) {
  if (user.role === 'admin') return;
  if (purchase.status !== 'pending') {
    throw new ForbiddenError('El encargado solo puede operar la recepción de una compra pendiente');
  }
  assertBranchAccess(user, purchase.branchId);
}

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

  app.get('/purchases/:id/success', async (req) => {
    const { id } = req.params as { id: string };
    return computeSuccess(id);
  });

  app.post('/purchases', { preHandler: requireRole('admin') }, async (req) => {
    const body = headerSchema.parse(req.body);
    return createPurchase(body, req.user.userId);
  });

  app.put('/purchases/:id', async (req) => {
    const { id } = req.params as { id: string };
    const current = await getPurchase(id); // 404 si no existe
    assertCanEditPurchase(req.user, current); // admin siempre; encargado solo recepción pendiente de su sucursal
    const body = updateSchema.parse(req.body);
    return updatePurchase(id, body as any, req.user.userId);
  });

  // Finalizar borrador → pendiente (y otras transiciones) es acto de compra: solo admin.
  app.patch('/purchases/:id/status', { preHandler: requireRole('admin') }, async (req) => {
    const { id } = req.params as { id: string };
    const { status } = z.object({ status: z.string() }).parse(req.body);
    return setPurchaseStatus(id, status, req.user.userId);
  });

  app.post('/purchases/:id/cancel', { preHandler: requireRole('admin') }, async (req) => {
    const { id } = req.params as { id: string };
    return setPurchaseStatus(id, 'cancelled', req.user.userId);
  });

  // Recepción: impacta stock + crea/actualiza productos + encola push TN.
  // Abierto a encargado, pero solo sobre compras de SU sucursal (admin cualquiera).
  app.post('/purchases/:id/receive', async (req) => {
    const { id } = req.params as { id: string };
    const current = await getPurchase(id);
    assertBranchAccess(req.user, current.branchId);
    return receivePurchase(id, req.user.userId);
  });

  // Escaneo de factura con IA (Claude). Devuelve líneas extraídas; no persiste.
  app.post('/purchases/:id/scan', { preHandler: requireRole('admin') }, async (req) => {
    const { id } = req.params as { id: string };
    const { documentId } = z.object({ documentId: z.string() }).parse(req.body);
    return scanInvoice(id, documentId);
  });

  // Auto-match de líneas contra variantes existentes (barcode/SKU). No persiste.
  // Solo lectura → disponible para el encargado (lo usa al escanear en la recepción).
  app.post('/purchases/match', async (req) => {
    const body = z.object({
      lines: z.array(z.object({
        barcode: z.string().nullable().optional(),
        sku: z.string().nullable().optional(),
      })),
    }).parse(req.body);
    return autoMatch(body.lines);
  });

  app.delete('/purchases/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await deletePurchase(id, req.user.userId);
    return reply.status(204).send();
  });

  // Subir factura (PDF o imagen) como documento de la compra.
  app.post('/purchases/:id/documents', { preHandler: requireRole('admin') }, async (req) => {
    const { id } = req.params as { id: string };
    await getPurchase(id); // valida que exista (404 si no)
    const file = await (req as any).file();
    if (!file) throw new Error('No file uploaded');
    const buf = await file.toBuffer();
    return savePurchaseDocument(id, buf, file.mimetype ?? 'application/octet-stream', file.filename ?? 'documento');
  });

  // Imagen de producto en staging (para items que se publicarán en TN al recibir).
  // El encargado puede subirla para un producto nuevo que reconoce en la recepción.
  app.post('/purchases/:id/staging-image', async (req) => {
    const { id } = req.params as { id: string };
    const current = await getPurchase(id);
    assertCanEditPurchase(req.user, current);
    const file = await (req as any).file();
    if (!file) throw new Error('No file uploaded');
    const buf = await file.toBuffer();
    return savePurchaseStagingImage(id, buf, file.mimetype ?? 'image/jpeg', file.filename ?? 'imagen');
  });
}
