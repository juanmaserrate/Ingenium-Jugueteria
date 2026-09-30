import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../auth/jwt.js';
import {
  listEmployees, createEmployee, updateEmployee, deleteEmployee,
  listShifts, upsertShift,
} from '../services/employees.js';

const empSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  lastname: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  branchId: z.string().nullable().optional(),
  role: z.string().nullable().optional(),
  hourlyRate: z.number().nullable().optional(),
  hireDate: z.string().nullable().optional(),
  active: z.boolean().optional(),
});

export async function employeesRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  // Alta/baja/edición de empleados = gestión → solo admin. Los turnos (fichaje) y las
  // lecturas quedan abiertos para el operador.
  const adminOnly = { preHandler: requireRole('admin') };
  app.get('/employees', async () => listEmployees());
  app.post('/employees', adminOnly, async (req) => createEmployee(empSchema.parse(req.body)));
  app.put('/employees/:id', adminOnly, async (req) => {
    const { id } = req.params as { id: string };
    return updateEmployee(id, empSchema.partial().parse(req.body));
  });
  app.delete('/employees/:id', adminOnly, async (req) => {
    const { id } = req.params as { id: string };
    return deleteEmployee(id);
  });

  // Turnos / horas del mes.
  app.get('/shifts', async (req) => {
    const q = req.query as { employeeId?: string; month?: string };
    return listShifts({ employeeId: q.employeeId, month: q.month });
  });
  app.put('/shifts', async (req) => {
    const body = z.object({
      employeeId: z.string(),
      date: z.string(),
      checkIn: z.string().nullable().optional(),
      checkOut: z.string().nullable().optional(),
      note: z.string().nullable().optional(),
    }).parse(req.body);
    return upsertShift(body);
  });
}
