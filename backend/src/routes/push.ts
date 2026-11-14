import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { registerPushToken, unregisterPushToken } from '../services/push.js';

// Rutas de notificaciones push de la app móvil (Expo).
export async function pushRoutes(app: FastifyInstance) {
  app.register(async (r) => {
    r.addHook('preHandler', app.authenticate);

    // El dispositivo registra su ExponentPushToken al iniciar sesión.
    r.post('/push/register', async (req) => {
      const b = z.object({
        token: z.string(),
        platform: z.string().optional(),
        branchId: z.string().optional(),
      }).parse(req.body);
      const user = (req as any).user || {};
      return registerPushToken({
        token: b.token,
        platform: b.platform,
        branchId: b.branchId ?? user.branchId,
        userId: user.userId,
      });
    });

    r.post('/push/unregister', async (req) => {
      const b = z.object({ token: z.string() }).parse(req.body);
      return unregisterPushToken(b.token);
    });
  });
}
