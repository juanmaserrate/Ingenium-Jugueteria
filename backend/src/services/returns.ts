import { prisma } from '../db.js';
import { logAudit, AUDIT_ACTIONS } from '../utils/audit.js';
import { randomId } from '../utils/crypto.js';
import { nextCounter } from './counters.js';
import { adjustStock } from './stock.js';
import { enqueueSync } from '../sync/queue.js';
import { ValidationError } from '../utils/errors.js';

export type ReturnItemInput = { variantId: string; qty: number; unitPrice: number };

export type ReturnInput = {
  branchId: string;
  originalSaleId?: string | null;
  customerId?: string | null;
  returnedItems: ReturnItemInput[];
  takenItems: ReturnItemInput[];
  refundPayments?: Array<{ methodId: string; methodName: string; amount: number }>;
  emitCreditNote?: boolean;
  reason?: string;
  userId?: string;
  source?: 'pos' | 'tn_cancelled';
  tnOrderId?: string | null;
};

export async function listReturns(opts: { branchId?: string } = {}) {
  return prisma.return.findMany({
    where: opts.branchId ? { branchId: opts.branchId } : undefined,
    orderBy: { datetime: 'desc' },
    take: 200,
  });
}

export async function processReturn(input: ReturnInput) {
  if (input.returnedItems.length === 0 && input.takenItems.length === 0) {
    throw new ValidationError('La devoluci\u00f3n no tiene items');
  }
  const returnedTotal = input.returnedItems.reduce((s, i) => s + i.qty * i.unitPrice, 0);
  const takenTotal = input.takenItems.reduce((s, i) => s + i.qty * i.unitPrice, 0);
  const difference = returnedTotal - takenTotal;

  const returnId = await prisma.$transaction(async (tx) => {
    const rid = randomId();
    const number = await nextCounter(`return_${input.branchId}_${new Date().getFullYear()}`);

    // Restore stock of returned items
    for (const it of input.returnedItems) {
      await adjustStock(it.variantId, input.branchId, it.qty, {
        skipTnSync: true,
        tx,
        reason: `Return ${rid}`,
      });
    }
    // Decrement stock of taken items (exchange)
    for (const it of input.takenItems) {
      await adjustStock(it.variantId, input.branchId, -it.qty, {
        skipTnSync: true,
        tx,
        reason: `Exchange ${rid}`,
      });
    }

    let creditNoteId: string | null = null;
    if (input.emitCreditNote && difference > 0) {
      const cnId = randomId();
      const issuedAt = new Date();
      const expiresAt = new Date(issuedAt);
      expiresAt.setMonth(expiresAt.getMonth() + 6);
      await tx.creditNote.create({
        data: {
          id: cnId,
          code: `NC-${Date.now().toString(36).toUpperCase()}`,
          customerId: input.customerId ?? null,
          amount: difference,
          issuedAt,
          expiresAt,
        },
      });
      creditNoteId = cnId;
    }

    await tx.return.create({
      data: {
        id: rid,
        number,
        datetime: new Date(),
        branchId: input.branchId,
        originalSaleId: input.originalSaleId ?? null,
        customerId: input.customerId ?? null,
        returnedItems: input.returnedItems as any,
        takenItems: input.takenItems as any,
        returnedTotal,
        takenTotal,
        difference,
        payments: (input.refundPayments ?? []) as any,
        reason: input.reason ?? null,
        creditNoteId,
        userId: input.userId ?? null,
        source: input.source ?? 'pos',
        tnOrderId: input.tnOrderId ?? null,
      },
    });

    // Cash movement for refund if in cash
    if (difference > 0 && input.refundPayments && input.refundPayments.length > 0) {
      const cash = input.refundPayments.reduce((s, p) => s + p.amount, 0);
      if (cash > 0) {
        await tx.cashMovement.create({
          data: {
            id: randomId(),
            datetime: new Date(),
            branchId: input.branchId,
            type: 'return',
            amountIn: 0,
            amountOut: cash,
            description: `Devoluci\u00f3n #${number}`,
            refId: rid,
            userId: input.userId ?? null,
          },
        });
      }
    }

    return rid;
  });

  await logAudit({
    userId: input.userId,
    action: AUDIT_ACTIONS.RETURN_PROCESSED,
    entity: 'return',
    entityId: returnId,
    description: input.reason,
  });

  const variantsAffected = [
    ...input.returnedItems.map((i) => i.variantId),
    ...input.takenItems.map((i) => i.variantId),
  ];
  for (const vid of [...new Set(variantsAffected)]) {
    await enqueueSync('push_stock', { variantId: vid });
  }

  return prisma.return.findUnique({ where: { id: returnId } });
}
