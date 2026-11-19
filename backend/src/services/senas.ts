import { prisma } from '../db.js';
import { randomId } from '../utils/crypto.js';
import { nextCounter } from './counters.js';
import { logAudit, AUDIT_ACTIONS } from '../utils/audit.js';
import { ValidationError } from '../utils/errors.js';
import { senaLeftover } from './senaMath.js';

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

export async function listSenas(opts: { customerId?: string; status?: string; branchId?: string } = {}) {
  const where: any = {};
  if (opts.customerId) where.customerId = opts.customerId;
  if (opts.status) where.status = opts.status;
  if (opts.branchId) where.branchId = opts.branchId;
  const rows = await prisma.sena.findMany({
    where: Object.keys(where).length ? where : undefined,
    orderBy: { createdAt: 'desc' },
    take: 1000,
    include: { customer: { select: { id: true, name: true, documentNumber: true, phone: true } } },
  });
  // N° de la venta en la que se usó (para mostrarlo en el listado).
  const saleIds = [...new Set(rows.map((r) => r.redeemedSaleId).filter(Boolean) as string[])];
  const sales = saleIds.length
    ? await prisma.sale.findMany({ where: { id: { in: saleIds } }, select: { id: true, number: true } })
    : [];
  const numById = new Map(sales.map((x) => [x.id, x.number]));
  return rows.map((r) => ({ ...r, redeemedSaleNumber: r.redeemedSaleId ? numById.get(r.redeemedSaleId) ?? null : null }));
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

export type SenaRefund = { methodId?: string | null; methodName?: string | null; affectsCash?: boolean };

// Marca una seña como usada (redeemed) y la vincula a la venta. Se llama desde
// confirmSale cuando un pago trae senaId. Usar la seña NO mueve la caja (la plata ya
// entró al crearla). Si la seña es MAYOR que lo que cubre en la venta, el sobrante se
// devuelve al cliente por el medio elegido: solo si es efectivo sale de la caja.
export async function redeemSena(
  senaId: string,
  saleId: string,
  opts: { amount?: number; customerId?: string | null; refund?: SenaRefund | null; branchId?: string; userId?: string | null; tx?: any } = {},
) {
  const client = opts.tx ?? prisma;
  const sena = await client.sena.findUnique({ where: { id: senaId } });
  if (!sena) throw new ValidationError('Seña no encontrada');
  if (sena.status !== 'active') throw new ValidationError(`La seña #${sena.number} ya fue usada o cancelada`);
  // Debe ser del mismo cliente de la venta: no se puede usar la seña de otro.
  if (sena.customerId && opts.customerId && sena.customerId !== opts.customerId) {
    throw new ValidationError(`La seña #${sena.number} es de otro cliente`);
  }
  const applied = opts.amount ?? sena.amount;
  // El monto aplicado no puede superar el valor de la seña (evita "pagar" $20.000
  // con una seña de $500). Tolerancia de $0.01 por coma flotante.
  if (applied > sena.amount + 0.01) {
    throw new ValidationError(`La seña #${sena.number} es por $${sena.amount} y no cubre $${applied}`);
  }
  const leftover = senaLeftover(sena.amount, applied);
  // Sobrante: por defecto se devuelve por el mismo medio con el que se dejó la seña.
  const refundAffectsCash = leftover > 0 ? (opts.refund?.affectsCash ?? sena.affectsCash) : null;
  const refundMethodId = leftover > 0 ? (opts.refund?.methodId ?? sena.methodId ?? null) : null;
  const refundMethodName = leftover > 0 ? (opts.refund?.methodName ?? sena.methodName ?? null) : null;
  const refundBranchId = leftover > 0 ? (opts.branchId ?? sena.branchId) : null;

  // Canje atómico: solo si sigue activa. Evita doble canje concurrente (dos ventas
  // simultáneas con la misma seña).
  const res = await client.sena.updateMany({
    where: { id: senaId, status: 'active' },
    data: {
      status: 'redeemed', redeemedAt: new Date(), redeemedSaleId: saleId,
      usedAmount: applied,
      refundAmount: leftover > 0 ? leftover : null,
      refundMethodId, refundMethodName, refundAffectsCash, refundBranchId,
    },
  });
  if (res.count !== 1) throw new ValidationError(`La seña #${sena.number} ya fue usada`);

  if (leftover > 0 && refundAffectsCash) {
    await client.cashMovement.create({
      data: {
        id: randomId(),
        datetime: new Date(),
        branchId: refundBranchId!,
        type: 'sena_refund',
        amountIn: 0,
        amountOut: leftover,
        description: `Devolución sobrante seña #${sena.number}`,
        refId: senaId,
        userId: opts.userId ?? null,
      },
    });
  }
  return sena;
}

// Al ANULAR una venta, las señas que se usaron en ella vuelven a estar disponibles por su
// monto completo. Si se había devuelto un sobrante en efectivo, esa salida de caja se revierte.
export async function reactivateSenasOfSale(saleId: string, opts: { userId?: string | null; tx?: any } = {}) {
  const client = opts.tx ?? prisma;
  const senas = await client.sena.findMany({ where: { redeemedSaleId: saleId, status: 'redeemed' } });
  for (const sena of senas) {
    if (sena.refundAmount && sena.refundAmount > 0 && sena.refundAffectsCash) {
      await client.cashMovement.create({
        data: {
          id: randomId(),
          datetime: new Date(),
          branchId: sena.refundBranchId ?? sena.branchId,
          type: 'sena_refund',
          amountIn: sena.refundAmount,
          amountOut: 0,
          description: `Reversión devolución seña #${sena.number} (venta anulada)`,
          refId: sena.id,
          userId: opts.userId ?? null,
        },
      });
    }
    await client.sena.update({
      where: { id: sena.id },
      data: {
        status: 'active', redeemedAt: null, redeemedSaleId: null, usedAmount: null,
        refundAmount: null, refundMethodId: null, refundMethodName: null, refundAffectsCash: null, refundBranchId: null,
      },
    });
  }
  return senas.length;
}

// Cancela una seña activa devolviéndole la plata al cliente. Se ELIGE cómo se devuelve:
// si es en efectivo sale de la caja (de la sucursal donde se hace la devolución); con
// cualquier otro medio no impacta en la caja.
export async function cancelSena(senaId: string, userId?: string, refund?: (SenaRefund & { branchId?: string }) | null) {
  const sena = await prisma.sena.findUnique({ where: { id: senaId } });
  if (!sena) throw new ValidationError('Seña no encontrada');
  if (sena.status !== 'active') throw new ValidationError('Solo se pueden cancelar señas activas');
  const refundAffectsCash = refund?.affectsCash ?? sena.affectsCash;
  const refundBranchId = refund?.branchId ?? sena.branchId;
  await prisma.$transaction(async (tx) => {
    const upd = await tx.sena.updateMany({
      where: { id: senaId, status: 'active' },
      data: {
        status: 'cancelled', cancelledAt: new Date(),
        refundAmount: sena.amount,
        refundMethodId: refund?.methodId ?? sena.methodId ?? null,
        refundMethodName: refund?.methodName ?? sena.methodName ?? null,
        refundAffectsCash, refundBranchId,
      },
    });
    if (upd.count !== 1) throw new ValidationError('La seña ya fue usada o cancelada');
    if (refundAffectsCash) {
      await tx.cashMovement.create({
        data: {
          id: randomId(),
          datetime: new Date(),
          branchId: refundBranchId,
          type: 'sena_refund',
          amountIn: 0,
          amountOut: sena.amount,
          description: `Devolución seña #${sena.number}`,
          refId: senaId,
          userId: userId ?? null,
        },
      });
    }
  });
  await logAudit({ userId, action: AUDIT_ACTIONS.UPDATE, entity: 'sena', entityId: senaId, description: `Seña cancelada y devuelta (${refund?.methodName ?? sena.methodName ?? 's/medio'})` });
  return prisma.sena.findUnique({ where: { id: senaId } });
}
