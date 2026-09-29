import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';

// Huella liviana del estado del servidor para el aviso "hay datos nuevos".
// NO trae datos: solo conteos y el último updatedAt de las tablas que tardan
// en propagarse entre PCs (productos, catálogo, clientes, empleados, config).
// El stock/ventas NO entran a propósito, para que el aviso no parpadee con
// cada venta de la otra sucursal. Consulta barata (count + max), ~1/min por PC.
export async function syncStateRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/sync-state', async () => {
    const [prod, catC, subC, brandC, supC, cust, emp, setMax] = await Promise.all([
      prisma.product.aggregate({ _count: true, _max: { updatedAt: true } }),
      prisma.category.count(),
      prisma.subcategory.count(),
      prisma.brand.count(),
      prisma.supplier.count(),
      prisma.customer.aggregate({ _count: true, _max: { createdAt: true } }),
      prisma.employee.aggregate({ _count: true, _max: { createdAt: true } }),
      prisma.setting.aggregate({ _max: { updatedAt: true } }),
    ]);
    const t = (d: Date | null | undefined) => (d ? d.getTime() : 0);
    const fp = [
      `p${prod._count}:${t(prod._max.updatedAt)}`,
      `c${catC}`, `s${subC}`, `b${brandC}`, `u${supC}`,
      `cu${cust._count}:${t(cust._max.createdAt)}`,
      `e${emp._count}:${t(emp._max.createdAt)}`,
      `st${t(setMax._max.updatedAt)}`,
    ].join('|');
    return { fp };
  });
}
