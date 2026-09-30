import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../auth/jwt.js';
import { listJobs, redriveFailed, reapStuckJobs, queueStats } from '../sync/queue.js';

export async function syncRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/sync/queue', async (req) => {
    const q = req.query as { status?: string };
    return listJobs(q.status);
  });

  // Salud de la cola: conteo por estado (queued/running/done/failed) para el panel.
  app.get('/sync/stats', async () => queueStats());

  // Re-drive manual: reintenta los jobs 'failed' (todos, o los ids indicados). Sirve
  // para recuperar sincronizaciones que agotaron los reintentos sin quedar pegadas.
  app.post('/sync/redrive', { preHandler: requireRole('admin') }, async (req) => {
    const body = z.object({ ids: z.array(z.string()).optional() }).parse(req.body ?? {});
    const count = await redriveFailed(body.ids);
    return { ok: true, requeued: count };
  });

  // Reaper manual: re-encola jobs 'running' huérfanos (lease vencida). El worker ya lo
  // corre solo, pero deja forzarlo desde el panel.
  app.post('/sync/reap', { preHandler: requireRole('admin') }, async () => {
    const count = await reapStuckJobs(0);
    return { ok: true, reaped: count };
  });
}
