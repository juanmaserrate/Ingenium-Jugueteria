import type { FastifyInstance } from 'fastify';
import { listJobs } from '../sync/queue.js';

export async function syncRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/sync/queue', async (req) => {
    const q = req.query as { status?: string };
    return listJobs(q.status);
  });
}
