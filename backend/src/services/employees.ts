import { prisma } from '../db.js';
import { randomId } from '../utils/crypto.js';

export type EmployeeInput = {
  id?: string;
  name: string;
  lastname?: string | null;
  email?: string | null;
  phone?: string | null;
  branchId?: string | null;
  role?: string | null;
  hourlyRate?: number | null;
  hireDate?: string | null;
  active?: boolean;
};

export async function listEmployees() {
  return prisma.employee.findMany({ orderBy: { name: 'asc' } });
}

export async function createEmployee(data: EmployeeInput) {
  return prisma.employee.create({
    data: {
      id: data.id ?? randomId(),
      name: data.name,
      lastname: data.lastname ?? null,
      email: data.email ?? null,
      phone: data.phone ?? null,
      branchId: data.branchId ?? null,
      role: data.role ?? null,
      hourlyRate: data.hourlyRate ?? 0,
      hireDate: data.hireDate ?? null,
      active: data.active ?? true,
    },
  });
}

export async function updateEmployee(id: string, data: Partial<EmployeeInput>) {
  return prisma.employee.update({
    where: { id },
    data: {
      name: data.name ?? undefined,
      lastname: data.lastname ?? undefined,
      email: data.email ?? undefined,
      phone: data.phone ?? undefined,
      branchId: data.branchId ?? undefined,
      role: data.role ?? undefined,
      hourlyRate: data.hourlyRate ?? undefined,
      hireDate: data.hireDate ?? undefined,
      active: data.active ?? undefined,
    },
  });
}

export async function deleteEmployee(id: string) {
  await prisma.employee.delete({ where: { id } });
  return { ok: true };
}

// Turnos/horas. Se filtran por empleado y mes ("YYYY-MM").
export async function listShifts(opts: { employeeId?: string; month?: string } = {}) {
  const where: any = {};
  if (opts.employeeId) where.employeeId = opts.employeeId;
  if (opts.month) where.date = { startsWith: opts.month };
  return prisma.shift.findMany({ where: Object.keys(where).length ? where : undefined });
}

// Upsert de un turno de un día (idempotente por empleado+fecha).
export async function upsertShift(data: { employeeId: string; date: string; checkIn?: string | null; checkOut?: string | null; note?: string | null }) {
  const existing = await prisma.shift.findFirst({ where: { employeeId: data.employeeId, date: data.date } });
  if (existing) {
    return prisma.shift.update({
      where: { id: existing.id },
      data: {
        checkIn: data.checkIn ?? undefined,
        checkOut: data.checkOut ?? undefined,
        notes: data.note ?? undefined,
      },
    });
  }
  return prisma.shift.create({
    data: {
      id: randomId(),
      employeeId: data.employeeId,
      date: data.date,
      checkIn: data.checkIn ?? null,
      checkOut: data.checkOut ?? null,
      notes: data.note ?? null,
    },
  });
}
