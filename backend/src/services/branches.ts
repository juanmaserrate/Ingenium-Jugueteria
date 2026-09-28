import { prisma } from '../db.js';
import { randomId } from '../utils/crypto.js';
import { ValidationError } from '../utils/errors.js';

export async function listBranches() {
  return prisma.branch.findMany({ orderBy: { name: 'asc' } });
}

export async function createBranch(data: { id?: string; name: string; address?: string | null; phone?: string | null }) {
  return prisma.branch.create({
    data: {
      id: data.id ?? randomId(),
      name: data.name,
      address: data.address ?? null,
      phone: data.phone ?? null,
    },
  });
}

export async function updateBranch(id: string, data: { name?: string; address?: string | null; phone?: string | null }) {
  return prisma.branch.update({
    where: { id },
    data: {
      name: data.name ?? undefined,
      address: data.address ?? undefined,
      phone: data.phone ?? undefined,
    },
  });
}

// Borra una sucursal SOLO si no tiene datos asociados (evita romper referencias).
export async function deleteBranch(id: string) {
  const [users, sales, returns, stock] = await Promise.all([
    prisma.user.count({ where: { branchId: id } }),
    prisma.sale.count({ where: { branchId: id } }),
    prisma.return.count({ where: { branchId: id } }),
    prisma.stock.count({ where: { branchId: id } }),
  ]);
  if (users || sales || returns || stock) {
    throw new ValidationError('No se puede borrar: la sucursal tiene usuarios, ventas, devoluciones o stock. Está en uso.');
  }
  await prisma.branch.delete({ where: { id } });
  return { ok: true };
}
