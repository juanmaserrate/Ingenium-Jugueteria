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
import { buildSyncPlan, applyLinks, ensureProductMapping, unlinkProduct, productMlStatus } from '../mercadolibre/syncExisting.js';
import { ValidationError } from '../utils/errors.js';
import { applyStoreTermsToItem, linkedItemIds } from '../mercadolibre/terms.js';
import { listCategoryMap, suggestForCategory, setCategoryMap, suggestFromListings, requiredListAttrs, setCategoryDefaultAttrs } from '../mercadolibre/categoryMap.js';
import { isHistoricalOrder } from '../services/pendingMath.js';

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
      // Tope: tras sincronizar puede haber cientos; el detalle por producto está en Inventario.
      const maps = await prisma.variantMeliMapping.findMany({ orderBy: { createdAt: 'desc' }, take: 150 });
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
      await ensureProductMapping(variant.productId, mlItemId);
      await enqueueSync('ml_push_stock', { variantId }); // empuja el stock ya mismo
      return { ok: true, variantId, mlItemId };
    });

    r.post('/integrations/ml/unlink', adminOnly, async (req, reply) => {
      const b = (req.body ?? {}) as { variantId?: string };
      if (!b.variantId) return reply.status(400).send({ error: 'Falta variantId' });
      const variant = await prisma.variant.findUnique({ where: { id: b.variantId }, select: { productId: true } });
      await prisma.variantMeliMapping.deleteMany({ where: { variantId: b.variantId } });
      if (variant) {
        const sibs = await prisma.variant.findMany({ where: { productId: variant.productId }, select: { id: true } });
        const left = await prisma.variantMeliMapping.count({ where: { variantId: { in: sibs.map((v) => v.id) } } });
        if (left === 0) await unlinkProduct(variant.productId);
      }
      return { ok: true };
    });

    // --- Publicar en ML (Fase 3) ---
    r.get('/integrations/ml/predict-category', adminOnly, async (req, reply) => {
      const title = String((req.query as any).title ?? '').trim();
      if (!title) return reply.status(400).send({ error: 'Falta title' });
      try { return await predictCategory(title); }
      catch (err: any) { return reply.status(502).send({ error: 'No se pudo predecir', details: err?.response?.data ?? err?.message }); }
    });

    // Despublicar: cierra TODAS las publicaciones del producto en ML (fan-out = varios items) y
    // limpia los mapeos + el flag. Deshace un publish, sea simple, con variaciones o fan-out.
    r.post('/integrations/ml/unpublish', adminOnly, async (req) => {
      const b = (req.body ?? {}) as { productId?: string; itemId?: string };
      let productId = b.productId;

      // Resolver el producto desde el item si no vino el productId (para limpiar todo su fan-out).
      if (!productId && b.itemId) {
        const vm = await prisma.variantMeliMapping.findFirst({ where: { mlItemId: b.itemId }, include: { variant: true } });
        productId = vm?.variant?.productId ?? undefined;
      }

      // Reunir todos los items a cerrar: el del body + el de ProductMeliMapping + los de cada variante.
      const itemIds = new Set<string>();
      if (b.itemId) itemIds.add(b.itemId);
      if (productId) {
        const pm = await prisma.productMeliMapping.findUnique({ where: { productId } });
        if (pm?.mlItemId) itemIds.add(pm.mlItemId);
        const variants = await prisma.variant.findMany({ where: { productId }, select: { id: true } });
        const vmaps = await prisma.variantMeliMapping.findMany({ where: { variantId: { in: variants.map((v) => v.id) } } });
        for (const m of vmaps) if (m.mlItemId) itemIds.add(m.mlItemId);
      }

      const results: Array<{ itemId: string; closed: boolean; deleted: boolean }> = [];
      if (itemIds.size) {
        const { getMlClient } = await import('../mercadolibre/client.js');
        const ml = await getMlClient();
        for (const id of itemIds) {
          let closed = false, deleted = false;
          if (ml) {
            try {
              await ml.updateItem(id, { status: 'closed' }); closed = true;
              try { await ml.updateItem(id, { deleted: true }); deleted = true; } catch { /* cerrar alcanza */ }
            } catch { /* seguimos con la limpieza local igual */ }
          }
          results.push({ itemId: id, closed, deleted });
        }
      }

      if (productId) {
        const variants = await prisma.variant.findMany({ where: { productId }, select: { id: true } });
        await prisma.variantMeliMapping.deleteMany({ where: { variantId: { in: variants.map((v) => v.id) } } });
        await prisma.productMeliMapping.deleteMany({ where: { productId } });
        await prisma.product.update({ where: { id: productId }, data: { publishedMeli: false } }).catch(() => {});
      } else {
        for (const id of itemIds) {
          await prisma.variantMeliMapping.deleteMany({ where: { mlItemId: id } });
          await prisma.productMeliMapping.deleteMany({ where: { mlItemId: id } });
        }
      }
      return { ok: true, items: results, closed: results.filter((r2) => r2.closed).length, total: results.length };
    });

    // --- Sincronizar las publicaciones que YA existen en ML con el inventario ---
    // Plan (no escribe nada): trae las publicaciones vigentes y propone el emparejamiento.
    r.post('/integrations/ml/sync-plan', adminOnly, async (_req, reply) => {
      try {
        return await buildSyncPlan();
      } catch (err: any) {
        return reply.status(502).send({ error: 'No se pudo leer Mercado Libre', details: err?.response?.data ?? err?.message });
      }
    });

    // Aplica los vínculos confirmados (variante ↔ publicación/variación) y empuja el stock.
    r.post('/integrations/ml/sync-apply', adminOnly, async (req) => {
      const b = z.object({
        links: z.array(z.object({
          variantId: z.string(),
          mlItemId: z.string(),
          mlVariationId: z.string().nullable().optional(),
          push: z.boolean().optional(),
        })).max(2000),
      }).parse(req.body);
      return applyLinks(b.links);
    });

    // Desvincula un producto de ML sin cerrar la publicación (deja de sincronizar stock).
    r.post('/integrations/ml/unlink-product', adminOnly, async (req, reply) => {
      const b = (req.body ?? {}) as { productId?: string };
      if (!b.productId) return reply.status(400).send({ error: 'Falta productId' });
      return unlinkProduct(b.productId);
    });

    // Estado en vivo de las publicaciones de un producto (stock sistema vs stock real en ML).
    r.get('/integrations/ml/product-status/:productId', adminOnly, async (req, reply) => {
      const { productId } = req.params as { productId: string };
      try {
        return await productMlStatus(productId);
      } catch (err: any) {
        return reply.status(502).send({ error: 'No se pudo consultar ML', details: err?.response?.data ?? err?.message });
      }
    });

    // --- Condiciones de la tienda: garantía de 30 días + retiro en persona ---
    // Publicaciones vinculadas al inventario (para aplicarles las condiciones de a tandas).
    r.get('/integrations/ml/linked-items', adminOnly, async () => ({ itemIds: await linkedItemIds() }));

    // Aplica garantía + retiro en persona a una tanda de publicaciones (máx 15 por llamada).
    r.post('/integrations/ml/apply-terms', adminOnly, async (req) => {
      const b = z.object({ itemIds: z.array(z.string()).min(1).max(15) }).parse(req.body);
      const results = [];
      for (const id of b.itemIds) results.push(await applyStoreTermsToItem(id));
      return { results };
    });

    // --- Mapeo de categorías del sistema → categorías de Mercado Libre ---
    r.get('/integrations/ml/category-map', adminOnly, async () => listCategoryMap());

    r.post('/integrations/ml/category-map/:id/suggest', adminOnly, async (req, reply) => {
      const { id } = req.params as { id: string };
      try { return await suggestForCategory(id); }
      catch (err: any) {
        if (err instanceof ValidationError) throw err;
        return reply.status(502).send({ error: 'No se pudo consultar Mercado Libre', details: err?.response?.data ?? err?.message });
      }
    });

    // Sugerencias a partir de las publicaciones que el vendedor ya tiene en ML (tarda ~30 s).
    r.post('/integrations/ml/category-map/from-listings', adminOnly, async (_req, reply) => {
      try { return await suggestFromListings(); }
      catch (err: any) {
        if (err instanceof ValidationError) throw err;
        return reply.status(502).send({ error: 'No se pudo leer Mercado Libre', details: err?.response?.data ?? err?.message });
      }
    });

    // Datos con lista de valores que ML exige en una categoría (para dejarlos fijos por categoría).
    r.get('/integrations/ml/category-required/:mlCategoryId', adminOnly, async (req, reply) => {
      const { mlCategoryId } = req.params as { mlCategoryId: string };
      try { return await requiredListAttrs(mlCategoryId); }
      catch (err: any) { return reply.status(502).send({ error: 'No se pudo consultar Mercado Libre', details: err?.response?.data ?? err?.message }); }
    });

    r.put('/integrations/ml/category-map/:id/attributes', adminOnly, async (req) => {
      const { id } = req.params as { id: string };
      const b = z.object({ attributes: z.array(z.object({ id: z.string(), name: z.string().optional(), value_name: z.string() })) }).parse(req.body);
      return setCategoryDefaultAttrs(id, b.attributes);
    });

    r.put('/integrations/ml/category-map/:id', adminOnly, async (req) => {
      const { id } = req.params as { id: string };
      const b = z.object({ mlCategoryId: z.string().nullable() }).parse(req.body);
      return setCategoryMap(id, b.mlCategoryId);
    });

    r.post('/integrations/ml/publish', adminOnly, async (req, reply) => {
      const b = z.object({
        productId: z.string().optional(),
        barcode: z.string().optional(),
        categoryId: z.string().optional(),
        listingTypeId: z.string(),
        price: z.number().optional(),
        quantity: z.number().optional(),
        title: z.string().optional(),
        condition: z.string().optional(),
        familyName: z.string().optional(),
        dryRun: z.boolean().optional(),
        pictures: z.array(z.string()).optional(),
        attributes: z.array(z.object({ id: z.string(), value_name: z.string() })).optional(),
      }).parse(req.body);
      if (!b.productId && !b.barcode) return reply.status(400).send({ error: 'Falta productId o barcode' });
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
      const rows = await prisma.mlOrderPending.findMany({ where: { status }, orderBy: { receivedAt: 'desc' }, take: 300 });
      const integ = await prisma.integration.findUnique({ where: { provider: 'mercadolibre' } });
      // Sin rawPayload (pesado). orderDate = fecha real de la compra; historical = anterior a
      // la conexión de la cuenta. Las más nuevas primero.
      return rows
        .map(({ rawPayload, ...o }) => {
          const orderDate = (rawPayload as any)?.date_created ?? null;
          return { ...o, orderDate, historical: isHistoricalOrder(orderDate, integ?.connectedAt) };
        })
        .sort((a, b) => String(b.orderDate ?? b.receivedAt).localeCompare(String(a.orderDate ?? a.receivedAt)));
    });

    // Descarta una orden pendiente (no es una venta a registrar: ya se cargó por otro lado,
    // es historial, etc.). No toca stock físico; libera la reserva si la tenía.
    r.post('/ml-orders/:id/dismiss', adminOnly, async (req) => {
      const { id } = req.params as { id: string };
      const pending = await prisma.mlOrderPending.findUnique({ where: { id } });
      if (!pending) throw new ValidationError('Orden no encontrada');
      const upd = await prisma.mlOrderPending.updateMany({ where: { id, status: 'pending' }, data: { status: 'dismissed' } });
      if (upd.count !== 1) throw new ValidationError('La orden ya fue procesada');
      try {
        const { repushStockForOrderItems } = await import('../services/pendingReserve.js');
        await repushStockForOrderItems('ml', pending.items);
      } catch { /* best-effort */ }
      return { ok: true };
    });

    // Descarta de una vez todo el HISTORIAL (compras anteriores a la conexión de la cuenta)
    // que el respaldo importó como pendiente.
    r.post('/ml-orders/dismiss-historical', adminOnly, async () => {
      const integ = await prisma.integration.findUnique({ where: { provider: 'mercadolibre' } });
      const rows = await prisma.mlOrderPending.findMany({ where: { status: 'pending' }, select: { id: true, rawPayload: true } });
      const ids = rows.filter((o) => isHistoricalOrder((o.rawPayload as any)?.date_created, integ?.connectedAt)).map((o) => o.id);
      if (!ids.length) return { ok: true, dismissed: 0 };
      const upd = await prisma.mlOrderPending.updateMany({ where: { id: { in: ids }, status: 'pending' }, data: { status: 'dismissed' } });
      return { ok: true, dismissed: upd.count };
    });

    // "Ya las cobré: empezar desde ahora". Fija el corte en este momento y descarta TODO lo
    // pendiente: lo pagado antes del corte no vuelve a entrar (ni por aviso ni por el respaldo).
    // No registra ventas ni toca el stock físico; libera la reserva de esas unidades.
    r.post('/ml-orders/start-now', adminOnly, async () => {
      const now = new Date();
      await prisma.integration.update({ where: { provider: 'mercadolibre' }, data: { ordersFrom: now } });
      const rows = await prisma.mlOrderPending.findMany({ where: { status: 'pending' }, select: { id: true, items: true } });
      const upd = await prisma.mlOrderPending.updateMany({ where: { id: { in: rows.map((o) => o.id) }, status: 'pending' }, data: { status: 'dismissed' } });
      try {
        const { repushStockForOrderItems } = await import('../services/pendingReserve.js');
        await repushStockForOrderItems('ml', rows.flatMap((o) => (Array.isArray(o.items) ? (o.items as any[]) : [])));
      } catch { /* best-effort */ }
      return { ok: true, dismissed: upd.count, ordersFrom: now.toISOString() };
    });

    r.get('/ml-orders/pending-count', async () => {
      maybeReconcileMl(); // respaldo: el poll del menú también recupera webhooks perdidos
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
      // La reserva de la pendiente se libera recién ahora: re-publicar el stock ya final.
      try {
        const { repushStockForOrderItems } = await import('../services/pendingReserve.js');
        await repushStockForOrderItems('ml', pending.items);
      } catch { /* best-effort */ }
      return { ok: true, saleId: sale.id };
    });
  });
}
