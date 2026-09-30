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

// Borra una sucursal SOLO si no tiene NINGÚN dato asociado. Se chequean todas las
// relaciones que apuntan a Branch (ver schema: users, stocks, sales, returns,
// cashMoves, expenses, employees, transfersIn/Out, notifications, purchases). Si
// no se chequearan todas, el DELETE violaría una FK y Prisma tiraría un 500 feo en
// vez de un mensaje claro.
export async function deleteBranch(id: string) {
  const [users, sales, returns, stock, cashMoves, expenses, employees, transfersIn, transfersOut, notifications, purchases] = await Promise.all([
    prisma.user.count({ where: { branchId: id } }),
    prisma.sale.count({ where: { branchId: id } }),
    prisma.return.count({ where: { branchId: id } }),
    prisma.stock.count({ where: { branchId: id } }),
    prisma.cashMovement.count({ where: { branchId: id } }),
    prisma.expense.count({ where: { branchId: id } }),
    prisma.employee.count({ where: { branchId: id } }),
    prisma.transfer.count({ where: { toBranch: id } }),
    prisma.transfer.count({ where: { fromBranch: id } }),
    prisma.notification.count({ where: { branchId: id } }),
    prisma.purchase.count({ where: { branchId: id } }),
  ]);
  const blockers: string[] = [];
  if (users) blockers.push('usuarios');
  if (sales) blockers.push('ventas');
  if (returns) blockers.push('devoluciones');
  if (stock) blockers.push('stock');
  if (cashMoves) blockers.push('movimientos de caja');
  if (expenses) blockers.push('gastos');
  if (employees) blockers.push('empleados');
  if (transfersIn || transfersOut) blockers.push('transferencias');
  if (notifications) blockers.push('notificaciones');
  if (purchases) blockers.push('compras');
  if (blockers.length) {
    throw new ValidationError(`No se puede borrar: la sucursal tiene ${blockers.join(', ')}. Está en uso.`);
  }
  await prisma.branch.delete({ where: { id } });
  return { ok: true };
}
