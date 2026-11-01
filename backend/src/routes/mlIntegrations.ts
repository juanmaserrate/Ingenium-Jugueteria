import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { env } from '../config.js';
import { buildAuthorizeUrl, exchangeCodeForToken, saveMlIntegration, disconnect } from '../mercadolibre/oauth.js';
import { requireRole } from '../auth/jwt.js';
import { enqueueSync } from '../sync/queue.js';
import { computeMlStockForVariant } from '../services/stock.js';

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
  });
}
