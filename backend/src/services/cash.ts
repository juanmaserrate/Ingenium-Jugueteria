import { prisma } from '../db.js';
import { randomId } from '../utils/crypto.js';

export async function balance(branchId: string): Promise<number> {
  const movements = await prisma.cashMovement.findMany({ where: { branchId } });
  return movements.reduce((s, m) => s + m.amountIn - m.amountOut, 0);
}

export async function listMovements(branchId: string) {
  return prisma.cashMovement.findMany({ where: { branchId }, orderBy: { datetime: 'asc' } });
}

export async function listExpenses(branchId: string) {
  return prisma.expense.findMany({ where: { branchId }, orderBy: { datetime: 'desc' } });
}

// Estado de la caja del día: si hubo apertura hoy y todavía no se cerró.
// Usa hora Argentina (-03:00) para el "hoy".
export async function dayStatus(branchId: string) {
  const now = new Date();
  const ar = new Date(now.getTime() - 3 * 3600 * 1000);
  const todayKey = ar.toISOString().slice(0, 10);
  const movements = await prisma.cashMovement.findMany({ where: { branchId }, orderBy: { datetime: 'desc' }, take: 200 });
  const todays = movements.filter((m) => new Date(m.datetime.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10) === todayKey);
  const opened = todays.some((m) => m.type === 'opening');
  const closed = todays.some((m) => m.type === 'closing');
  return { isOpen: opened && !closed, openedToday: opened, closedToday: closed };
}

export async function move(input: {
  branchId: string;
  type: string;
  amountIn?: number;
  amountOut?: number;
  description?: string;
  refId?: string;
  userId?: string;
}) {
  return prisma.cashMovement.create({
    data: {
      id: randomId(),
      datetime: new Date(),
      branchId: input.branchId,
      type: input.type,
      amountIn: input.amountIn ?? 0,
      amountOut: input.amountOut ?? 0,
      description: input.description ?? null,
      refId: input.refId ?? null,
      userId: input.userId ?? null,
    },
  });
}

export async function openDay(branchId: string, initialAmount: number, userId?: string) {
  return move({
    branchId,
    type: 'opening',
    amountIn: initialAmount,
    description: 'Apertura de caja',
    userId,
  });
}

export async function closeDay(branchId: string, countedAmount: number, userId?: string) {
  const current = await balance(branchId);
  const diff = countedAmount - current;
  return move({
    branchId,
    type: 'closing',
    amountIn: diff > 0 ? diff : 0,
    amountOut: diff < 0 ? -diff : 0,
    description: `Cierre de caja (contado: ${countedAmount}, sistema: ${current})`,
    userId,
  });
}

export async function addExpense(input: {
  branchId: string;
  amount: number;
  category?: string;
  description?: string;
  paymentMethodId?: string;
  userId?: string;
}) {
  const expense = await prisma.expense.create({
    data: {
      id: randomId(),
      datetime: new Date(),
      branchId: input.branchId,
      amount: input.amount,
      category: input.category ?? null,
      description: input.description ?? null,
      paymentMethodId: input.paymentMethodId ?? null,
      userId: input.userId ?? null,
    },
  });
  // Solo impacta la caja si el gasto se pagó en efectivo.
  const isCash = ['cash', 'efectivo', 'efvo'].includes((input.paymentMethodId ?? 'cash').toLowerCase());
  if (isCash) {
    await move({
      branchId: input.branchId,
      type: 'expense',
      amountOut: input.amount,
      description: input.description ?? input.category ?? 'Gasto',
      refId: expense.id,
      userId: input.userId,
    });
  }
  return expense;
}
