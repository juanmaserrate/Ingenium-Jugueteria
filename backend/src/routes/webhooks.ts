import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { verifyHmac } from '../utils/crypto.js';
import { dispatchWebhook } from '../tiendanube/webhooks.js';

export async function webhooksRoutes(app: FastifyInstance) {
  const handler = async (req: any, reply: any) => {
    const integration = await prisma.integration.findUnique({ where: { provider: 'tiendanube' } });
    if (!integration || !integration.active || !integration.webhookSecret) {
      return reply.status(503).send({ error: 'Integration not active' });
    }
    const signature = (req.headers['x-linkedstore-hmac-sha256'] ?? req.headers['x-tiendanube-hmac-sha256']) as
      | string
      | undefined;
    const raw = (req as any).rawBody as string;
    if (!signature || !raw) {
      return reply.status(401).send({ error: 'Missing signature' });
    }
    if (!verifyHmac(integration.webhookSecret, raw, signature)) {
      // TN usa HMAC con el client secret. Probamos tambi\u00e9n con ese como fallback.
      const { env } = await import('../config.js');
      if (!verifyHmac(env.TN_CLIENT_SECRET, raw, signature)) {
        return reply.status(401).send({ error: 'Invalid signature' });
      }
    }
    const body = req.body as any;
    const event = body.event ?? '';
    try {
      const result = await dispatchWebhook(event, body);
      return reply.send({ ok: true, result });
    } catch (err: any) {
      app.log.error({ err: err.message, event, body }, 'webhook dispatch failed');
      return reply.status(500).send({ error: err.message });
    }
  };

  // Main webhook endpoint (generic event dispatcher)
  app.post('/webhooks/tiendanube', handler);
  // GDPR-specific aliases required by TN Partners App
  app.post('/webhooks/tiendanube/store-redact', handler);
  app.post('/webhooks/tiendanube/customers-redact', handler);
  app.post('/webhooks/tiendanube/customers-data-request', handler);
}
