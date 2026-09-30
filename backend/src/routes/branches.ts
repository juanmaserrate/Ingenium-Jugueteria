import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../auth/jwt.js';
import { listBranches, createBranch, updateBranch, deleteBranch } from '../services/branches.js';

const schema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  address: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
});

export async function branchesRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  const adminOnly = { preHandler: requireRole('admin') };

  app.get('/branches', async () => listBranches());
  app.post('/branches', adminOnly, async (req) => createBranch(schema.parse(req.body)));
  app.put('/branches/:id', adminOnly, async (req) => {
    const { id } = req.params as { id: string };
    return updateBranch(id, schema.partial().parse(req.body));
  });
  app.delete('/branches/:id', adminOnly, async (req) => {
    const { id } = req.params as { id: string };
    return deleteBranch(id);
  });
}
