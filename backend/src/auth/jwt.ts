import jwt from '@fastify/jwt';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { env } from '../config.js';
import { UnauthorizedError, ForbiddenError } from '../utils/errors.js';

// preHandler de rol: se usa DESPUÉS de `authenticate` (que llena request.user).
// Ej: { preHandler: [app.authenticate, requireRole('admin')] }. Si el token no tiene
// un rol permitido, corta con 403. Solo protege el backend (el front ya oculta cosas
// por rol, pero eso es cosmético; esto es la barrera real vía API).
export function requireRole(...roles: string[]) {
  return async (request: FastifyRequest) => {
    const role = request.user?.role;
    if (!role || !roles.includes(role)) {
      throw new ForbiddenError('Esta acción es solo para administradores');
    }
  };
}

export type JwtPayload = {
  userId: string;
  branchId: string;
  role: string;
};

export async function registerJwt(app: FastifyInstance) {
  await app.register(jwt, {
    secret: env.JWT_SECRET,
    sign: { expiresIn: env.JWT_EXPIRES_IN },
  });

  app.decorate('authenticate', async (request: FastifyRequest, _reply: FastifyReply) => {
    try {
      await request.jwtVerify();
    } catch {
      throw new UnauthorizedError('Token inv\u00e1lido o expirado');
    }
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtPayload;
    user: JwtPayload;
  }
}
