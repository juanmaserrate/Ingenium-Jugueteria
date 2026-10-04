import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getAllSettings, getSetting, setSetting } from '../services/settings.js';
import { ForbiddenError } from '../utils/errors.js';

// Claves de configuración que puede editar cualquier usuario autenticado (operación del
// local, p. ej. las formas de pago). El resto de la config general es solo del admin.
const OPERATOR_WRITABLE_KEYS = new Set(['payment_methods']);

export async function settingsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/settings', async () => getAllSettings());

  app.get('/settings/:key', async (req) => {
    const { key } = req.params as { key: string };
    return { key, value: await getSetting(key) };
  });

  app.put('/settings/:key', async (req) => {
    const { key } = req.params as { key: string };
    const { value } = z.object({ value: z.any() }).parse(req.body);
    // payment_methods lo maneja el local → cualquier usuario logueado. El resto, solo admin.
    if (!OPERATOR_WRITABLE_KEYS.has(key) && req.user.role !== 'admin') {
      throw new ForbiddenError('Solo el administrador puede cambiar esta configuración');
    }
    return { key, value: await setSetting(key, value) };
  });
}
