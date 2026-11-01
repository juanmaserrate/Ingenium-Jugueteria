import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { env } from '../config.js';
import { buildAuthorizeUrl, exchangeCodeForToken, saveMlIntegration, disconnect } from '../mercadolibre/oauth.js';
import { requireRole } from '../auth/jwt.js';

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
  });
}
