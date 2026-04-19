import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import staticPlugin from '@fastify/static';
import cookie from '@fastify/cookie';
import path from 'node:path';
import { env, corsOrigins } from './config.js';
import { registerJwt } from './auth/jwt.js';
import { authRoutes } from './auth/routes.js';
import { productsRoutes } from './routes/products.js';
import { variantsRoutes } from './routes/variants.js';
import { stockRoutes } from './routes/stock.js';
import { salesRoutes } from './routes/sales.js';
import { returnsRoutes } from './routes/returns.js';
import { cashRoutes } from './routes/cash.js';
import { customersRoutes } from './routes/customers.js';
import { integrationsRoutes } from './routes/integrations.js';
import { webhooksRoutes } from './routes/webhooks.js';
import { syncRoutes } from './routes/sync.js';
import { imagesRoutes } from './routes/images.js';
import { AppError } from './utils/errors.js';
import { startSyncWorker } from './sync/worker.js';

async function main() {
  const app = Fastify({
    logger: env.NODE_ENV === 'development'
      ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
      : true,
    // Webhooks need raw body for HMAC verification
    bodyLimit: 10 * 1024 * 1024,
  });

  // CORS
  await app.register(cors, {
    origin: corsOrigins.length > 0 ? corsOrigins : true,
    credentials: true,
  });

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });

  // Raw body for webhook signature validation
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body, done) => {
      try {
        (req as any).rawBody = (body as Buffer).toString('utf8');
        const parsed = JSON.parse((body as Buffer).toString('utf8') || '{}');
        done(null, parsed);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  await registerJwt(app);

  // Local image storage served at /images
  if (env.STORAGE_DRIVER === 'local') {
    const abs = path.resolve(env.STORAGE_LOCAL_PATH);
    await app.register(staticPlugin, {
      root: abs,
      prefix: '/images/',
      decorateReply: false,
    });
  }

  // Global error handler
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        error: error.message,
        code: error.code,
        details: error.details,
      });
    }
    if ((error as any).validation) {
      return reply.status(400).send({ error: 'Validation error', details: (error as any).validation });
    }
    app.log.error(error);
    return reply.status(500).send({ error: 'Internal server error' });
  });

  // Health
  app.get('/health', async () => ({ status: 'ok', ts: Date.now() }));

  // Routes
  await app.register(authRoutes);
  await app.register(productsRoutes, { prefix: '/api' });
  await app.register(variantsRoutes, { prefix: '/api' });
  await app.register(stockRoutes, { prefix: '/api' });
  await app.register(salesRoutes, { prefix: '/api' });
  await app.register(returnsRoutes, { prefix: '/api' });
  await app.register(cashRoutes, { prefix: '/api' });
  await app.register(customersRoutes, { prefix: '/api' });
  await app.register(integrationsRoutes, { prefix: '/api' });
  await app.register(imagesRoutes, { prefix: '/api' });
  await app.register(syncRoutes, { prefix: '/api' });
  // Webhooks SIN prefix /api porque TN los consulta en URL p\u00fablica
  await app.register(webhooksRoutes);

  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info(`Ingenium backend listening on ${env.HOST}:${env.PORT}`);

  // Start background sync worker
  startSyncWorker(app.log);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
