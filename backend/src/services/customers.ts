import { prisma } from '../db.js';
import { randomId } from '../utils/crypto.js';
import { logAudit, AUDIT_ACTIONS } from '../utils/audit.js';

export type CustomerInput = {
  id?: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  birthday?: Date | null;
  documentType?: string | null;
  documentNumber?: string | null;
  address?: string | null;
  city?: string | null;
  notes?: string | null;
  tnCustomerId?: string | null;
};

export async function listCustomers() {
  return prisma.customer.findMany({ orderBy: { name: 'asc' } });
}

export async function getCustomer(id: string) {
  return prisma.customer.findUnique({ where: { id } });
}

export async function findOrCreateByEmail(email: string, data: CustomerInput) {
  const existing = await prisma.customer.findFirst({ where: { email } });
  if (existing) {
    // Vinculaci\u00f3n autom\u00e1tica si no ten\u00eda tnCustomerId
    if (data.tnCustomerId && !existing.tnCustomerId) {
      return prisma.customer.update({
        where: { id: existing.id },
        data: { tnCustomerId: data.tnCustomerId },
      });
    }
    return existing;
  }
  return createCustomer(data);
}

export async function createCustomer(data: CustomerInput, userId?: string) {
  const id = data.id ?? randomId();
  const created = await prisma.customer.create({
    data: {
      id,
      name: data.name,
      phone: data.phone ?? null,
      email: data.email ?? null,
      birthday: data.birthday ?? null,
      documentType: data.documentType ?? null,
      documentNumber: data.documentNumber ?? null,
      address: data.address ?? null,
      city: data.city ?? null,
      notes: data.notes ?? null,
      tnCustomerId: data.tnCustomerId ?? null,
    },
  });
  await logAudit({ userId, action: AUDIT_ACTIONS.CREATE, entity: 'customer', entityId: id, after: created });
  return created;
}

export async function updateCustomer(id: string, data: Partial<CustomerInput>, userId?: string) {
  const before = await prisma.customer.findUnique({ where: { id } });
  const updated = await prisma.customer.update({
    where: { id },
    data: {
      name: data.name ?? undefined,
      phone: data.phone ?? undefined,
      email: data.email ?? undefined,
      birthday: data.birthday ?? undefined,
      documentType: data.documentType ?? undefined,
      documentNumber: data.documentNumber ?? undefined,
      address: data.address ?? undefined,
      city: data.city ?? undefined,
      notes: data.notes ?? undefined,
      tnCustomerId: data.tnCustomerId ?? undefined,
    },
  });
  await logAudit({ userId, action: AUDIT_ACTIONS.UPDATE, entity: 'customer', entityId: id, before, after: updated });
  return updated;
}
