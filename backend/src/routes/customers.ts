import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  listCustomers,
  getCustomer,
  createCustomer,
  updateCustomer,
  findByDocument,
} from '../services/customers.js';
import { listSales } from '../services/sales.js';

const schema = z.object({
  id: z.string().optional(),
  name: z.string(),
  phone: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  birthday: z.coerce.date().nullable().optional(),
  documentType: z.string().nullable().optional(),
  documentNumber: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

export async function customersRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/customers', async () => listCustomers());

  // Búsqueda por número de documento (identificador principal). Devuelve el
  // cliente o null. Debe ir ANTES de /customers/:id para no capturarla como id.
  app.get('/customers/by-document/:doc', async (req) => {
    const { doc } = req.params as { doc: string };
    return (await findByDocument(doc)) ?? null;
  });

  app.get('/customers/:id', async (req) => {
    const { id } = req.params as { id: string };
    return getCustomer(id);
  });

  // Compras (ventas confirmadas) de un cliente.
  app.get('/customers/:id/sales', async (req) => {
    const { id } = req.params as { id: string };
    return listSales({ customerId: id, status: 'confirmed', limit: 500 });
  });

  app.post('/customers', async (req) => {
    const body = schema.parse(req.body);
    return createCustomer(body, req.user.userId);
  });

  app.put('/customers/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = schema.partial().parse(req.body);
    return updateCustomer(id, body, req.user.userId);
  });
}
