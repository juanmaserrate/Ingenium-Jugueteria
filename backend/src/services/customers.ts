import { prisma } from '../db.js';
import { randomId } from '../utils/crypto.js';
import { logAudit, AUDIT_ACTIONS } from '../utils/audit.js';
import { ValidationError } from '../utils/errors.js';

// Normaliza el documento: sólo dígitos/letras, sin espacios ni puntos.
export function normalizeDoc(doc?: string | null): string | null {
  if (!doc) return null;
  const clean = String(doc).replace(/[^0-9a-zA-Z]/g, '').trim();
  return clean || null;
}

export async function findByDocument(documentNumber: string) {
  const doc = normalizeDoc(documentNumber);
  if (!doc) return null;
  return prisma.customer.findFirst({ where: { documentNumber: doc } });
}

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
  // Sin email no se puede deduplicar: buscar {email: ''} matchearía a cualquier
  // cliente sin email. En ese caso siempre creamos uno nuevo.
  const existing = email ? await prisma.customer.findFirst({ where: { email } }) : null;
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
  // Identificador principal: el número de documento no se puede duplicar.
  const doc = normalizeDoc(data.documentNumber);
  if (doc) {
    const dup = await prisma.customer.findFirst({ where: { documentNumber: doc } });
    if (dup) throw new ValidationError(`Ya existe un cliente con el documento ${doc}: ${dup.name}`);
  }
  const created = await prisma.customer.create({
    data: {
      id,
      name: data.name,
      phone: data.phone ?? null,
      email: data.email ?? null,
      birthday: data.birthday ?? null,
      documentType: data.documentType ?? null,
      documentNumber: doc,
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
  // Si cambia el documento, normalizar y verificar que no colisione con otro cliente.
  let docUpdate: string | null | undefined = undefined;
  if (data.documentNumber !== undefined) {
    docUpdate = normalizeDoc(data.documentNumber);
    if (docUpdate) {
      const dup = await prisma.customer.findFirst({ where: { documentNumber: docUpdate, id: { not: id } } });
      if (dup) throw new ValidationError(`Ya existe un cliente con el documento ${docUpdate}: ${dup.name}`);
    }
  }
  const updated = await prisma.customer.update({
    where: { id },
    data: {
      name: data.name ?? undefined,
      phone: data.phone ?? undefined,
      email: data.email ?? undefined,
      birthday: data.birthday ?? undefined,
      documentType: data.documentType ?? undefined,
      documentNumber: docUpdate,
      address: data.address ?? undefined,
      city: data.city ?? undefined,
      notes: data.notes ?? undefined,
      tnCustomerId: data.tnCustomerId ?? undefined,
    },
  });
  await logAudit({ userId, action: AUDIT_ACTIONS.UPDATE, entity: 'customer', entityId: id, before, after: updated });
  return updated;
}

// Borra un cliente SOLO si no tiene historial (ventas, devoluciones o señas).
// Si lo tiene, no se puede borrar sin romper las FK: se avisa con un error claro.
export async function deleteCustomer(id: string, userId?: string) {
  const before = await prisma.customer.findUnique({ where: { id } });
  if (!before) throw new ValidationError('Cliente no encontrado');
  const [sales, returns, senas] = await Promise.all([
    prisma.sale.count({ where: { customerId: id } }),
    prisma.return.count({ where: { customerId: id } }),
    prisma.sena.count({ where: { customerId: id } }),
  ]);
  if (sales > 0 || returns > 0 || senas > 0) {
    throw new ValidationError('No se puede borrar: el cliente tiene ventas, devoluciones o señas asociadas.');
  }
  await prisma.customer.delete({ where: { id } });
  await logAudit({ userId, action: AUDIT_ACTIONS.DELETE, entity: 'customer', entityId: id, before });
  return { ok: true };
}
