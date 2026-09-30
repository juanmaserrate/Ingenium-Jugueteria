import type { FastifyInstance } from 'fastify';
import { getDashboard, getBalance, getProfits, getContribution, getAudit } from '../services/metrics.js';
import { ValidationError } from '../utils/errors.js';

export async function metricsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  // branchId ausente = consolidado (todas las sucursales). Para el no-admin forzamos SU
  // sucursal: no puede ver el consolidado ni otra sucursal.
  const scopedBranch = (req: any, q: { branchId?: string }) =>
    req.user.role === 'admin' ? (q.branchId || undefined) : req.user.branchId;

  app.get('/metrics/dashboard', async (req) => {
    const q = req.query as { branchId?: string; month?: string; today?: string };
    const today = q.today || new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
    const month = q.month || today.slice(0, 7);
    return getDashboard({ branchId: scopedBranch(req, q), month, today });
  });

  app.get('/metrics/balance', async (req) => {
    const q = req.query as { branchId?: string; from?: string; to?: string };
    if (!q.from || !q.to) throw new ValidationError('from y to requeridos (ISO)');
    return getBalance({ branchId: scopedBranch(req, q), from: q.from, to: q.to });
  });

  app.get('/metrics/profits', async (req) => {
    const q = req.query as { branchId?: string; month?: string };
    const month = q.month || new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 7);
    return getProfits({ branchId: scopedBranch(req, q), month });
  });

  app.get('/metrics/contribution', async (req) => {
    const q = req.query as { branchId?: string; month?: string; view?: string; topN?: string };
    const month = q.month || new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 7);
    return getContribution({
      branchId: scopedBranch(req, q),
      month,
      view: q.view || 'product',
      topN: q.topN ? Number(q.topN) : undefined,
    });
  });

  app.get('/audit', async (req) => {
    const q = req.query as any;
    return getAudit({ from: q.from, to: q.to, action: q.action, entity: q.entity, userId: q.userId, q: q.q });
  });
}
