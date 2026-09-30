import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../auth/jwt.js';
import { getAllSettings, getSetting, setSetting } from '../services/settings.js';

export async function settingsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/settings', async () => getAllSettings());

  app.get('/settings/:key', async (req) => {
    const { key } = req.params as { key: string };
    return { key, value: await getSetting(key) };
  });

  // Cambiar la configuración es solo del admin (medios de pago, config general, etc.).
  app.put('/settings/:key', { preHandler: requireRole('admin') }, async (req) => {
    const { key } = req.params as { key: string };
    const { value } = z.object({ value: z.any() }).parse(req.body);
    return { key, value: await setSetting(key, value) };
  });
}
