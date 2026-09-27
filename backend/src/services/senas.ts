import { prisma } from '../db.js';
import { randomId } from '../utils/crypto.js';
import { nextCounter } from './counters.js';
import { logAudit, AUDIT_ACTIONS } from '../utils/audit.js';
import { ValidationError } from '../utils/errors.js';

// Mismo criterio que ventas/caja: sólo el efectivo mueve la caja.
function isCashMethod(methodId?: string | null) {
  return ['cash', 'efectivo', 'efvo'].includes((methodId || '').toLowerCase());
}

export type SenaInput = {
  customerId: string;
  amount: number;
  branchId: string;
  methodId?: string | null;
  methodName?: string | null;
  affectsCash?: boolean;
  note?: string | null;
  userId?: string;
};

export async function listSenas(opts: { customerId?: string; status?: string } = {}) {
  const where: any = {};
  if (opts.customerId) where.customerId = opts.customerId;
  if (opts.status) where.status = opts.status;
  return prisma.sena.findMany({
    where: Object.keys(where).length ? where : undefined,
    orderBy: { createdAt: 'desc' },
    take: 1000,
  });
}

export async function getSenaByNumber(number: number) {
  return prisma.sena.findFirst({ where: { number, status: 'active' } });
}

export async function createSena(input: SenaInput) {
  if (!input.customerId) throw new ValidationError('La seña requiere un cliente');
  if (!(input.amount > 0)) throw new ValidationError('El monto de la seña debe ser mayor a 0');
  const affectsCash = input.affectsCash ?? isCashMethod(input.methodId);

  const senaId = await prisma.$transaction(async (tx) => {
    const sid = randomId();
    const number = await nextCounter(`sena_${input.branchId}_${new Date().getFullYear()}`, tx);
    await tx.sena.create({
      data: {
        id: sid,
        number,
        customerId: input.customerId,
        amount: input.amount,
        status: 'active',
        note: input.note ?? null,
        branchId: input.branchId,
        methodId: input.methodId ?? null,
        methodName: input.methodName ?? null,
        affectsCash,
        userId: input.userId ?? null,
      },
    });
    // Si se dejó en efectivo, la plata ENTRA a la caja al crear la seña.
    if (affectsCash) {
      await tx.cashMovement.create({
        data: {
          id: randomId(),
          datetime: new Date(),
          branchId: input.branchId,
          type: 'sena',
          amountIn: input.amount,
          amountOut: 0,
          description: `Seña #${number}`,
          refId: sid,
          userId: input.userId ?? null,
        },
      });
    }
    return sid;
  });

  await logAudit({
    userId: input.userId,
    action: AUDIT_ACTIONS.CREATE,
    entity: 'sena',
    entityId: senaId,
    description: `Seña por ${input.amount}`,
  });
  return prisma.sena.findUnique({ where: { id: senaId } });
}

// Marca una seña como usada (redeemed) y la vincula a la venta. Se llama desde
// confirmSale cuando un pago trae senaId. NO mueve la caja (la plata ya entró al
// crearla) ni suma a lo facturado (eso lo excluyen las métricas).
export async function redeemSena(senaId: string, saleId: string, tx?: any) {
  const client = tx ?? prisma;
  const sena = await client.sena.findUnique({ where: { id: senaId } });
  if (!sena) throw new ValidationError('Seña no encontrada');
  if (sena.status !== 'active') throw new ValidationError(`La seña #${sena.number} ya fue usada o cancelada`);
  await client.sena.update({
    where: { id: senaId },
    data: { status: 'redeemed', redeemedAt: new Date(), redeemedSaleId: saleId },
  });
  return sena;
}

export async function cancelSena(senaId: string, userId?: string) {
  const sena = await prisma.sena.findUnique({ where: { id: senaId } });
  if (!sena) throw new ValidationError('Seña no encontrada');
  if (sena.status !== 'active') throw new ValidationError('Solo se pueden cancelar señas activas');
  // Si había entrado a caja, se revierte (sale la plata de la caja al cancelar).
  await prisma.$transaction(async (tx) => {
    await tx.sena.update({ where: { id: senaId }, data: { status: 'cancelled' } });
    if (sena.affectsCash) {
      await tx.cashMovement.create({
        data: {
          id: randomId(),
          datetime: new Date(),
          branchId: sena.branchId,
          type: 'adjustment',
          amountIn: 0,
          amountOut: sena.amount,
          description: `Cancelación seña #${sena.number}`,
          refId: senaId,
          userId: userId ?? null,
        },
      });
    }
  });
  await logAudit({ userId, action: AUDIT_ACTIONS.UPDATE, entity: 'sena', entityId: senaId, description: 'Seña cancelada' });
  return prisma.sena.findUnique({ where: { id: senaId } });
}
