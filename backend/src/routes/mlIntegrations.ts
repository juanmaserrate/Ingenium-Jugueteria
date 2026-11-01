import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { env } from '../config.js';
import { buildAuthorizeUrl, exchangeCodeForToken, saveMlIntegration, disconnect } from '../mercadolibre/oauth.js';
import { requireRole } from '../auth/jwt.js';
import { enqueueSync } from '../sync/queue.js';
import { computeMlStockForVariant } from '../services/stock.js';
import { confirmSale } from '../services/sales.js';
import { buildCostMetaForMl } from '../services/paymentCost.js';
import { maybeReconcileMl } from '../mercadolibre/webhooks.js';
import { predictCategory, publishProduct } from '../mercadolibre/publish.js';
import { ValidationError } from '../utils/errors.js';

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// Resuelve el variantId local a partir de un item de orden ML (item + variación opcional).
async function resolveVariantId(mlItemId: string, mlVariationId: string | null): Promise<string | null> {
  const maps = await prisma.variantMeliMapping.findMany({ where: { mlItemId } });
  if (!maps.length) return null;
  if (mlVariationId) {
    return maps.find((m) => m.mlVariationId === String(mlVariationId))?.variantId
      ?? maps.find((m) => !m.mlVariationId)?.variantId
      ?? null;
  }
  return maps.find((m) => !m.mlVariationId)?.variantId ?? maps[0].variantId;
}

// Rutas de la integración con Mercado Libre. Todo queda DORMIDO mientras ML_CLIENT_ID esté
// vacío (sin credenciales no se puede conectar). Espeja el patrón de Tienda Nube.
export async function mlIntegrationsRoutes(app: FastifyInstance) {
  // Estado público (sin auth) para el ping del frontend.
  app.get('/integrations/ml/status', async () => {
    const integ = await prisma.integration.findUnique({ where: { provider: 'mercadolibre' } });
    return {
      configured: !!env.ML_CLIENT_ID,
      connected: !!integ?.active,
      mlUserId: integ?.mlUserId ?? null,
      connectedAt: integ?.connectedAt ?? null,
      lastSyncAt: integ?.lastSyncAt ?? null,
      tokenExpiresAt: integ?.tokenExpiresAt ?? null,
    };
  });

  // --- OAuth ---
  app.get('/integrations/ml/authorize', async (_req, reply) => {
    if (!env.ML_CLIENT_ID) return reply.status(500).send({ error: 'ML_CLIENT_ID no configurado' });
    return reply.redirect(buildAuthorizeUrl());
  });

  app.get('/integrations/ml/callback', async (req, reply) => {
    const code = (req.query as any).code as string | undefined;
    const error = (req.query as any).error as string | undefined;
    const base = env.PUBLIC_BASE_URL || env.CORS_ORIGINS.split(',')[0] || '';
    if (error) return reply.redirect(`${base}/app.html#/mercadolibre?error=${encodeURIComponent(error)}`);
    if (!code) return reply.status(400).send({ error: 'Missing code' });
    try {
      const token = await exchangeCodeForToken(code);
      await saveMlIntegration({
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresIn: token.expires_in,
        scope: token.scope,
        mlUserId: String(token.user_id),
      });
      return reply.redirect(`${base}/app.html#/mercadolibre?connected=1`);
    } catch (err: any) {
      app.log.error({ err: err?.response?.data ?? err?.message }, 'ML OAuth callback failed');
      return reply.redirect(`${base}/app.html#/mercadolibre?error=oauth`);
    }
  });

  // --- Autenticadas (admin) ---
  app.register(async (r) => {
    r.addHook('preHandler', app.authenticate);
    const adminOnly = { preHandler: requireRole('admin') };

    r.post('/integrations/ml/disconnect', adminOnly, async (req) => {
      await disconnect((req as any).user?.sub);
      return { ok: true };
    });

    // Prueba de conexión: trae los datos del vendedor (verifica token + refresh).
    r.get('/integrations/ml/me', adminOnly, async (_req, reply) => {
      const { getMlClient } = await import('../mercadolibre/client.js');
      const ml = await getMlClient();
      if (!ml) return reply.status(409).send({ error: 'Mercado Libre no está conectado' });
      try {
        const me = await ml.getMe();
        return { ok: true, id: me?.id, nickname: me?.nickname, site_id: me?.site_id };
      } catch (err: any) {
        return reply.status(502).send({ error: 'No se pudo consultar ML', details: err?.response?.data ?? err?.message });
      }
    });

    // --- Vinculación de publicaciones (Fase 1: stock) ---
    // Lista los mapeos actuales con nombre de producto/variante + stock publicado.
    r.get('/integrations/ml/mappings', adminOnly, async () => {
      const maps = await prisma.variantMeliMapping.findMany({ orderBy: { createdAt: 'desc' } });
      const out = [];
      for (const m of maps) {
        const v = await prisma.variant.findUnique({ where: { id: m.variantId }, include: { product: true } });
        out.push({
          variantId: m.variantId,
          mlItemId: m.mlItemId,
          mlVariationId: m.mlVariationId,
          productName: v?.product?.name ?? '(?)',
          variantName: v?.name ?? '',
          barcode: v?.barcode ?? null,
          stock: await computeMlStockForVariant(m.variantId),
          lastPushAt: m.lastPushAt,
        });
      }
      return out;
    });

    // Vincula una variante (por id o por barcode) a una publicación de ML y empuja el stock.
    r.post('/integrations/ml/link', adminOnly, async (req, reply) => {
      const b = (req.body ?? {}) as { variantId?: string; barcode?: string; mlItemId?: string; mlVariationId?: string };
      const mlItemId = String(b.mlItemId ?? '').trim();
      if (!mlItemId) return reply.status(400).send({ error: 'Falta mlItemId' });
      let variantId = b.variantId;
      if (!variantId && b.barcode) {
        const v = await prisma.variant.findFirst({ where: { OR: [{ barcode: b.barcode }, { code: b.barcode }] } });
        if (!v) return reply.status(404).send({ error: 'No se encontró una variante con ese código/barcode' });
        variantId = v.id;
      }
      if (!variantId) return reply.status(400).send({ error: 'Falta variantId o barcode' });
      const variant = await prisma.variant.findUnique({ where: { id: variantId } });
      if (!variant) return reply.status(404).send({ error: 'Variante inexistente' });
      await prisma.variantMeliMapping.upsert({
        where: { variantId },
        update: { mlItemId, mlVariationId: b.mlVariationId ?? null },
        create: { variantId, mlItemId, mlVariationId: b.mlVariationId ?? null },
      });
      await prisma.productMeliMapping.upsert({
        where: { productId: variant.productId },
        update: { mlItemId },
        create: { productId: variant.productId, mlItemId },
      }).catch(() => { /* ml_item_id ya usado por otro producto → ignorar el mapeo a nivel producto */ });
      await enqueueSync('ml_push_stock', { variantId }); // empuja el stock ya mismo
      return { ok: true, variantId, mlItemId };
    });

    r.post('/integrations/ml/unlink', adminOnly, async (req, reply) => {
      const b = (req.body ?? {}) as { variantId?: string };
      if (!b.variantId) return reply.status(400).send({ error: 'Falta variantId' });
      await prisma.variantMeliMapping.deleteMany({ where: { variantId: b.variantId } });
      return { ok: true };
    });

    // --- Publicar en ML (Fase 3) ---
    r.get('/integrations/ml/predict-category', adminOnly, async (req, reply) => {
      const title = String((req.query as any).title ?? '').trim();
      if (!title) return reply.status(400).send({ error: 'Falta title' });
      try { return await predictCategory(title); }
      catch (err: any) { return reply.status(502).send({ error: 'No se pudo predecir', details: err?.response?.data ?? err?.message }); }
    });

    r.post('/integrations/ml/publish', adminOnly, async (req, reply) => {
      const b = z.object({
        barcode: z.string(),
        categoryId: z.string().optional(),
        listingTypeId: z.string(),
        price: z.number().optional(),
        quantity: z.number().optional(),
        title: z.string().optional(),
        condition: z.string().optional(),
      }).parse(req.body);
      try {
        const res = await publishProduct(b);
        if ((res as any).error) return reply.status(422).send(res);
        return res;
      } catch (err: any) {
        return reply.status(502).send({ error: 'publish_failed', details: err?.response?.data ?? err?.message });
      }
    });

    // --- Órdenes de ML pendientes de asignar a sucursal (Fase 2) ---
    r.get('/ml-orders', async (req) => {
      maybeReconcileMl(); // respaldo: trae las que se hayan perdido por un webhook
      const status = (req.query as any).status ?? 'pending';
      return prisma.mlOrderPending.findMany({ where: { status }, orderBy: { receivedAt: 'desc' }, take: 100 });
    });

    r.get('/ml-orders/pending-count', async () => {
      const count = await prisma.mlOrderPending.count({ where: { status: 'pending' } });
      return { count };
    });

    // Asigna una orden de ML a una sucursal = la confirma como venta (con el costo MP real).
    // Espejo de /tn-orders/:id/assign.
    r.post('/ml-orders/:id/assign', async (req) => {
      const { id } = req.params as { id: string };
      const body = z.object({ branchId: z.string(), allowNegative: z.boolean().optional() }).parse(req.body);
      const pending = await prisma.mlOrderPending.findUnique({ where: { id } });
      if (!pending) throw new ValidationError('Orden pendiente no encontrada');
      if (pending.status !== 'pending') throw new ValidationError('La orden ya fue procesada');

      // Mapear items ML → variantes locales
      const items = pending.items as any[];
      const saleItems: Array<{ variantId: string; qty: number; unitPrice: number }> = [];
      const missing: any[] = [];
      for (const it of items) {
        const variantId = await resolveVariantId(String(it.mlItemId), it.mlVariationId != null ? String(it.mlVariationId) : null);
        if (!variantId) { missing.push(it); continue; }
        saleItems.push({ variantId, qty: Math.round(Number(it.qty)) || 0, unitPrice: Number(it.unitPrice) || 0 });
      }
      if (missing.length > 0) return { error: 'unmapped_items', missing };

      // La venta toma el subtotal de PRODUCTOS (no el total de la orden, que puede incluir envío).
      const saleAmount = round2(saleItems.reduce((s, it) => s + it.qty * it.unitPrice, 0));

      // Cliente por email si vino (ML rara vez lo expone).
      let customerId: string | null = null;
      if (pending.customerEmail) {
        const c = await prisma.customer.findFirst({ where: { email: pending.customerEmail } });
        customerId = c?.id ?? null;
      }

      // Claim atómico pending→assigning: si dos asignaciones llegan a la vez, solo una gana.
      const claim = await prisma.mlOrderPending.updateMany({ where: { id, status: 'pending' }, data: { status: 'assigning' } });
      if (claim.count !== 1) throw new ValidationError('La orden ya fue asignada o está en proceso');

      // Costo real de Mercado Pago (sale_fee de la orden), congelado en el pago.
      let mlCostMeta: any = null;
      try { mlCostMeta = await buildCostMetaForMl(pending.rawPayload as any, saleAmount, new Date()); } catch { mlCostMeta = null; }

      let sale;
      try {
        sale = await confirmSale(
          {
            branchId: body.branchId,
            customerId,
            items: saleItems,
            payments: [{ methodId: 'mercadolibre', methodName: 'Mercado Libre', amount: saleAmount, costMeta: mlCostMeta }],
            source: 'ml',
            offlineId: `ml_${pending.mlOrderId}`, // idempotencia: no duplica la venta
          },
          { userId: (req as any).user?.userId, allowNegative: body.allowNegative },
        );
      } catch (e) {
        await prisma.mlOrderPending.updateMany({ where: { id, status: 'assigning' }, data: { status: 'pending' } });
        throw e;
      }

      await prisma.mlOrderPending.update({
        where: { id },
        data: { status: 'assigned', assignedBranchId: body.branchId, assignedSaleId: sale.id, assignedAt: new Date() },
      });
      return { ok: true, saleId: sale.id };
    });
  });
}
