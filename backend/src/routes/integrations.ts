import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { env } from '../config.js';
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  saveIntegration,
  disconnect,
  registerWebhooks,
} from '../tiendanube/oauth.js';
import { randomId } from '../utils/crypto.js';
import { confirmSale } from '../services/sales.js';
import { enqueueSync } from '../sync/queue.js';

export async function integrationsRoutes(app: FastifyInstance) {
  // Status p\u00fablico (sin auth) para el ping del frontend
  app.get('/integrations/status', async () => {
    const integration = await prisma.integration.findUnique({ where: { provider: 'tiendanube' } });
    return {
      connected: !!integration?.active,
      tnStoreId: integration?.tnStoreId ?? null,
      connectedAt: integration?.connectedAt ?? null,
      lastSyncAt: integration?.lastSyncAt ?? null,
      stockMode: integration?.stockMode ?? 'sum',
    };
  });

  // --- OAuth flow ---
  app.get('/integrations/tiendanube/authorize', async (_req, reply) => {
    if (!env.TN_CLIENT_ID) {
      return reply.status(500).send({ error: 'TN_CLIENT_ID no configurado' });
    }
    const url = buildAuthorizeUrl();
    return reply.redirect(url);
  });

  app.get('/integrations/tiendanube/callback', async (req, reply) => {
    const code = (req.query as any).code as string | undefined;
    if (!code) return reply.status(400).send({ error: 'Missing code' });
    try {
      const token = await exchangeCodeForToken(code);
      const webhookSecret = randomId(32);
      await saveIntegration({
        accessToken: token.access_token,
        scope: token.scope,
        tnStoreId: String(token.user_id),
        webhookSecret,
      });
      await registerWebhooks(env.PUBLIC_BASE_URL);
      // Redirect de vuelta al frontend (hash route). Prefiere PUBLIC_BASE_URL
      // (dominio público del deploy) sobre CORS_ORIGINS para no terminar en localhost.
      const base = env.PUBLIC_BASE_URL || env.CORS_ORIGINS.split(',')[0] || '';
      return reply.redirect(`${base}/app.html#/integraciones?connected=1`);
    } catch (err: any) {
      app.log.error(err);
      return reply.status(500).send({ error: 'OAuth failed', details: err.message });
    }
  });

  // --- Rutas autenticadas ---
  app.register(async (r) => {
    r.addHook('preHandler', app.authenticate);

    r.post('/integrations/tiendanube/disconnect', async (req) => {
      await disconnect(req.user.userId);
      return { ok: true };
    });

    r.patch('/integrations/tiendanube/settings', async (req) => {
      const body = z
        .object({ stockMode: z.enum(['sum', 'lomas', 'banfield']).optional() })
        .parse(req.body);
      const updated = await prisma.integration.update({
        where: { provider: 'tiendanube' },
        data: { stockMode: body.stockMode ?? undefined },
      });
      return updated;
    });

    // --- TN Orders Pending ---
    r.get('/tn-orders', async (req) => {
      const q = req.query as { status?: string };
      return prisma.tnOrderPending.findMany({
        where: { status: q.status ?? 'pending' },
        orderBy: { receivedAt: 'desc' },
      });
    });

    r.post('/tn-orders/:id/assign', async (req) => {
      const { id } = req.params as { id: string };
      const body = z.object({ branchId: z.string(), allowNegative: z.boolean().optional() }).parse(req.body);
      const pending = await prisma.tnOrderPending.findUnique({ where: { id } });
      if (!pending) throw new Error('Pending order not found');
      if (pending.status !== 'pending') throw new Error('Order already processed');

      // Mapear items: tnVariantId -> variantId local
      const items = pending.items as any[];
      const tnVariantIds = items.map((i) => i.tnVariantId);
      const mappings = await prisma.variantTnMapping.findMany({
        where: { tnVariantId: { in: tnVariantIds } },
      });
      const mapByTn = new Map(mappings.map((m) => [m.tnVariantId, m.variantId]));
      const missing = items.filter((i) => !mapByTn.has(i.tnVariantId));
      if (missing.length > 0) {
        return { error: 'unmapped_items', missing };
      }

      // Crear venta
      const saleItems = items.map((i) => ({
        variantId: mapByTn.get(i.tnVariantId)!,
        qty: i.qty,
        unitPrice: i.unitPrice,
      }));

      // Buscar cliente por email
      let customerId: string | null = null;
      if (pending.customerEmail) {
        const c = await prisma.customer.findFirst({ where: { email: pending.customerEmail } });
        customerId = c?.id ?? null;
      }

      const sale = await confirmSale(
        {
          branchId: body.branchId,
          customerId,
          items: saleItems,
          payments: [{ methodId: 'tiendanube', methodName: 'Tienda Nube', amount: pending.total }],
          source: 'tn',
          tnOrderId: pending.tnOrderId,
        },
        { userId: req.user.userId, allowNegative: body.allowNegative },
      );

      await prisma.tnOrderPending.update({
        where: { id },
        data: {
          status: 'assigned',
          assignedBranchId: body.branchId,
          assignedSaleId: sale.id,
          assignedAt: new Date(),
        },
      });

      return { ok: true, saleId: sale.id };
    });

    // --- TN Products Pending ---
    r.get('/tn-products-pending', async (req) => {
      const q = req.query as { status?: string };
      return prisma.tnProductPending.findMany({
        where: { status: q.status ?? 'pending' },
        orderBy: { receivedAt: 'desc' },
      });
    });

    r.post('/tn-products-pending/:id/approve', async (req) => {
      const { id } = req.params as { id: string };
      const body = z
        .object({
          // Asignaci\u00f3n de stock por variante y sucursal
          stockAssignments: z.array(
            z.object({
              tnVariantId: z.string(),
              branchId: z.string(),
              qty: z.number().int().min(0),
            }),
          ),
          // Override opcional del costo por variante (TN no manda costo)
          costByVariant: z.record(z.number()).optional(),
        })
        .parse(req.body);

      const pending = await prisma.tnProductPending.findUnique({ where: { id } });
      if (!pending) throw new Error('Pending product not found');
      const tnProduct = pending.payload as any;

      // Crear producto local + variantes + mappings
      const productId = randomId();
      await prisma.$transaction(async (tx) => {
        await tx.product.create({
          data: {
            id: productId,
            code: tnProduct.variants?.[0]?.sku ?? `TN-${tnProduct.id}`,
            name: tnProduct.name?.es ?? 'Producto TN',
            description: tnProduct.description?.es ?? null,
            cost: 0,
            price: tnProduct.variants?.[0] ? parseFloat(tnProduct.variants[0].price) : 0,
            publishedTn: true,
          },
        });
        await tx.productTnMapping.create({
          data: {
            productId,
            tnProductId: String(tnProduct.id),
            lastPullAt: new Date(),
          },
        });
        for (const tnV of tnProduct.variants ?? []) {
          const vid = randomId();
          const attrs: Record<string, string> = {};
          (tnV.values ?? []).forEach((val: any, idx: number) => {
            const attrName = tnProduct.attributes?.[idx]?.es ?? `attr${idx + 1}`;
            attrs[attrName] = val.es ?? val;
          });
          await tx.variant.create({
            data: {
              id: vid,
              productId,
              name: (tnV.values ?? []).map((v: any) => v.es ?? v).join(' / ') || 'default',
              attributes: attrs as any,
              code: tnV.sku ?? null,
              barcode: tnV.barcode ?? null,
              priceOverride: parseFloat(tnV.price),
              costOverride: body.costByVariant?.[String(tnV.id)] ?? null,
              isDefault: (tnProduct.variants?.length ?? 0) === 1,
            },
          });
          await tx.variantTnMapping.create({
            data: {
              variantId: vid,
              tnProductId: String(tnProduct.id),
              tnVariantId: String(tnV.id),
              lastPullAt: new Date(),
            },
          });
          // Stock inicial por sucursal
          const branches = await tx.branch.findMany();
          for (const b of branches) {
            const assignment = body.stockAssignments.find(
              (a) => a.tnVariantId === String(tnV.id) && a.branchId === b.id,
            );
            await tx.stock.create({
              data: {
                id: `${vid}|${b.id}`,
                variantId: vid,
                branchId: b.id,
                qty: assignment?.qty ?? 0,
              },
            });
          }
        }
        // Descargar im\u00e1genes de TN
        // (En foreground simple: push_image_create por cada imagen)
        // Aqu\u00ed podr\u00edamos hacerlo, pero para simplificar lo dejamos como job separado.
      });

      await prisma.tnProductPending.update({
        where: { id },
        data: { status: 'approved', reviewedAt: new Date() },
      });

      // Tras aprobar, hacer push de stock (la cantidad asignada) a TN
      const variants = await prisma.variant.findMany({ where: { productId } });
      for (const v of variants) {
        await enqueueSync('push_stock', { variantId: v.id });
      }

      return { ok: true, productId };
    });

    r.post('/tn-products-pending/:id/reject', async (req) => {
      const { id } = req.params as { id: string };
      await prisma.tnProductPending.update({
        where: { id },
        data: { status: 'rejected', reviewedAt: new Date() },
      });
      return { ok: true };
    });

    // --- Sync Log ---
    r.get('/sync/log', async (req) => {
      const q = req.query as { limit?: string; status?: string };
      return prisma.tnSyncLog.findMany({
        where: q.status ? { status: q.status } : undefined,
        orderBy: { datetime: 'desc' },
        take: q.limit ? parseInt(q.limit) : 100,
      });
    });

    // --- Conflicts ---
    r.get('/sync/conflicts', async (req) => {
      const q = req.query as { status?: string };
      const { listConflicts } = await import('../sync/conflicts.js');
      return listConflicts(q.status ?? 'open');
    });

    r.post('/sync/conflicts/:id/resolve', async (req) => {
      const { id } = req.params as { id: string };
      const body = z.object({ resolution: z.enum(['accept', 'cancel', 'adjust']) }).parse(req.body);
      const { resolveConflict } = await import('../sync/conflicts.js');
      return resolveConflict(id, body.resolution, req.user.userId);
    });

    r.post('/sync/conflicts/:id/dismiss', async (req) => {
      const { id } = req.params as { id: string };
      const { dismissConflict } = await import('../sync/conflicts.js');
      return dismissConflict(id, req.user.userId);
    });
  });
}
