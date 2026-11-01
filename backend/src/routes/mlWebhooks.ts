import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { handleMlNotification } from '../mercadolibre/webhooks.js';

// Webhook de Mercado Libre (SIN prefix /api; ML pega a una URL pública). Las notificaciones
// NO vienen firmadas, así que respondemos 200 enseguida (ML exige respuesta rápida y reintenta
// 12h si no hay 200) y procesamos en segundo plano. La autenticidad se valida al ir a buscar
// la orden con nuestro token (handleMlNotification). Lo perdido lo levanta el reconcile.
export async function mlWebhooksRoutes(app: FastifyInstance) {
  app.post('/webhooks/ml', async (req, reply) => {
    const body = req.body as any;
    reply.send({ ok: true }); // responder YA
    try {
      const integ = await prisma.integration.findUnique({ where: { provider: 'mercadolibre' } });
      if (!integ?.active) return;
      void handleMlNotification(body).catch((err: any) =>
        app.log.error({ err: err?.response?.data ?? err?.message, body }, 'ml webhook dispatch failed'),
      );
    } catch (err) {
      app.log.error({ err }, 'ml webhook error');
    }
  });
}
