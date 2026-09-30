import jwt from '@fastify/jwt';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { env } from '../config.js';
import { prisma } from '../db.js';
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

// Aislamiento por sucursal: un usuario no-admin solo puede leer/operar sobre SU sucursal.
// El admin accede a cualquiera. Se llama dentro del handler, donde ya se conoce la
// sucursal objetivo (param/body/query). Debe correr después de `authenticate`, que dejó
// request.user.branchId fresco desde la DB.
export function assertBranchAccess(user: JwtPayload, branchId: string | null | undefined) {
  if (user.role === 'admin') return;
  if (!branchId || branchId !== user.branchId) {
    throw new ForbiddenError('Solo podés operar sobre tu sucursal');
  }
}

export type JwtPayload = {
  userId: string;
  branchId: string;
  role: string;
  tv?: number; // tokenVersion al momento de firmar (para revocación)
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
    // Revocaci\u00f3n + datos frescos: chequeamos contra la DB que el usuario siga activo y
    // que su tokenVersion coincida con la del token. As\u00ed, desactivar un usuario o forzar
    // cierre de sesi\u00f3n (bump de tokenVersion) invalida el token al toque, sin esperar los
    // 30 d\u00edas. Los tokens viejos (sin tv) valen como tv=0 \u2192 no se desloguea a nadie de
    // golpe. De paso refrescamos role/branchId por si el admin los cambi\u00f3 (aplica ya, sin
    // re-login).
    const p = request.user;
    const user = await prisma.user.findUnique({
      where: { id: p.userId },
      select: { active: true, tokenVersion: true, role: true, branchId: true },
    });
    if (!user || !user.active) throw new UnauthorizedError('Sesi\u00f3n revocada. Volv\u00e9 a iniciar sesi\u00f3n.');
    if ((p.tv ?? 0) !== user.tokenVersion) throw new UnauthorizedError('Sesi\u00f3n cerrada. Volv\u00e9 a iniciar sesi\u00f3n.');
    request.user.role = user.role;
    request.user.branchId = user.branchId;
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
