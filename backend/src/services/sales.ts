import { prisma } from '../db.js';
import { Prisma } from '@prisma/client';
import { NotFoundError, StockInsufficientError, ValidationError } from '../utils/errors.js';
import { logAudit, AUDIT_ACTIONS } from '../utils/audit.js';
import { randomId } from '../utils/crypto.js';
import { nextCounter } from './counters.js';
import { adjustStock, releaseReserved } from './stock.js';
import { enqueueSync } from '../sync/queue.js';

export type SalePaymentInput = {
  methodId: string;
  methodName: string;
  amount: number;
};

export type SaleItemInput = {
  variantId: string;
  qty: number;
  unitPrice: number;
  discountPct?: number | null;
  discountFixed?: number | null;
  priceOverridden?: boolean;
};

export type SaleInput = {
  id?: string;
  branchId: string;
  sellerId?: string | null;
  customerId?: string | null;
  items: SaleItemInput[];
  payments: SalePaymentInput[];
  discountGlobalPct?: number | null;
  discountGlobalFixed?: number | null;
  surchargeGlobalPct?: number | null;
  surchargeGlobalFixed?: number | null;
  source?: 'pos' | 'tn';
  tnOrderId?: string | null;
  offlineId?: string | null;
  datetime?: Date;
};

export async function listSales(opts: { branchId?: string; limit?: number } = {}) {
  return prisma.sale.findMany({
    where: opts.branchId ? { branchId: opts.branchId } : undefined,
    include: { items: true, payments: true, customer: true },
    orderBy: { datetime: 'desc' },
    take: opts.limit ?? 200,
  });
}

export async function getSale(id: string) {
  const sale = await prisma.sale.findUnique({
    where: { id },
    include: { items: true, payments: true, customer: true, branch: true, seller: true },
  });
  if (!sale) throw new NotFoundError('Sale', id);
  return sale;
}

function computeItemSubtotal(item: SaleItemInput): number {
  const base = item.qty * item.unitPrice;
  const pct = item.discountPct ? (base * item.discountPct) / 100 : 0;
  const fixed = item.discountFixed ?? 0;
  return Math.max(0, base - pct - fixed);
}

export async function confirmSale(input: SaleInput, opts: { userId?: string; allowNegative?: boolean } = {}) {
  if (!input.items || input.items.length === 0) throw new ValidationError('La venta no tiene items');
  if (!input.payments || input.payments.length === 0) throw new ValidationError('La venta no tiene pagos');

  const itemsSubtotal = input.items.reduce((s, it) => s + computeItemSubtotal(it), 0);
  const discountGlobal =
    (input.discountGlobalPct ? (itemsSubtotal * input.discountGlobalPct) / 100 : 0) +
    (input.discountGlobalFixed ?? 0);
  const surchargeGlobal =
    (input.surchargeGlobalPct ? (itemsSubtotal * input.surchargeGlobalPct) / 100 : 0) +
    (input.surchargeGlobalFixed ?? 0);
  const total = Math.max(0, itemsSubtotal - discountGlobal + surchargeGlobal);
  const paymentsTotal = input.payments.reduce((s, p) => s + p.amount, 0);
  if (Math.abs(paymentsTotal - total) > 0.01) {
    throw new ValidationError(`Total de pagos ${paymentsTotal} no coincide con total ${total}`);
  }

  // Atomic: validate stock, decrement, create sale, create cash movement
  const sale = await prisma.$transaction(async (tx) => {
    // Validate stock per item
    for (const it of input.items) {
      const stock = await tx.stock.findUnique({
        where: { variantId_branchId: { variantId: it.variantId, branchId: input.branchId } },
      });
      const available = (stock?.qty ?? 0) - (stock?.reservedQty ?? 0);
      if (!opts.allowNegative && available < it.qty) {
        throw new StockInsufficientError(it.variantId, input.branchId, available, it.qty);
      }
    }

    // Build snapshots
    const variantIds = input.items.map((i) => i.variantId);
    const variants = await tx.variant.findMany({
      where: { id: { in: variantIds } },
      include: { product: true },
    });
    const vmap = new Map(variants.map((v) => [v.id, v]));

    const number = await nextCounter(`sale_${input.branchId}_${new Date().getFullYear()}`);
    const saleId = input.id ?? randomId();
    const datetime = input.datetime ?? new Date();

    await tx.sale.create({
      data: {
        id: saleId,
        number,
        datetime,
        branchId: input.branchId,
        sellerId: input.sellerId ?? null,
        customerId: input.customerId ?? null,
        itemsSubtotal,
        discountTotal: discountGlobal,
        surchargeTotal: surchargeGlobal,
        total,
        discountGlobalPct: input.discountGlobalPct ?? null,
        discountGlobalFixed: input.discountGlobalFixed ?? null,
        surchargeGlobalPct: input.surchargeGlobalPct ?? null,
        surchargeGlobalFixed: input.surchargeGlobalFixed ?? null,
        status: 'confirmed',
        source: input.source ?? 'pos',
        tnOrderId: input.tnOrderId ?? null,
        offlineId: input.offlineId ?? null,
      },
    });

    for (const it of input.items) {
      const v = vmap.get(it.variantId);
      await tx.saleItem.create({
        data: {
          id: randomId(),
          saleId,
          variantId: it.variantId,
          productNameSnap: v?.product.name ?? '',
          variantNameSnap: v?.name ?? null,
          qty: it.qty,
          unitPrice: it.unitPrice,
          costSnapshot: v?.costOverride ?? v?.product.cost ?? 0,
          discountPct: it.discountPct ?? null,
          discountFixed: it.discountFixed ?? null,
          priceOverridden: it.priceOverridden ?? false,
          subtotal: computeItemSubtotal(it),
        },
      });
      // Decrement stock
      await adjustStock(it.variantId, input.branchId, -it.qty, {
        skipTnSync: true,
        tx,
        reason: `Sale ${saleId}`,
      });
    }

    for (const p of input.payments) {
      await tx.salePayment.create({
        data: {
          id: randomId(),
          saleId,
          methodId: p.methodId,
          methodName: p.methodName,
          amount: p.amount,
        },
      });
    }

    // Cash movement (only cash-like payments affect drawer; simplified: all go in)
    await tx.cashMovement.create({
      data: {
        id: randomId(),
        datetime,
        branchId: input.branchId,
        type: 'sale',
        amountIn: total,
        amountOut: 0,
        description: `Venta #${number}`,
        refId: saleId,
        userId: input.sellerId ?? null,
      },
    });

    return saleId;
  });

  await logAudit({
    userId: opts.userId ?? input.sellerId ?? undefined,
    action: AUDIT_ACTIONS.SALE_CONFIRMED,
    entity: 'sale',
    entityId: sale,
    description: `Venta confirmada (${input.source ?? 'pos'})`,
  });

  // Enqueue stock sync per variant
  const uniqueVariants = [...new Set(input.items.map((i) => i.variantId))];
  for (const vid of uniqueVariants) {
    await enqueueSync('push_stock', { variantId: vid });
  }

  // If this sale comes from TN → fulfill the order
  if (input.tnOrderId) {
    await enqueueSync('fulfill_tn_order', { tnOrderId: input.tnOrderId, saleId: sale });
  }

  return getSale(sale);
}

export async function cancelSale(id: string, opts: { userId?: string; reason?: string } = {}) {
  const sale = await getSale(id);
  if (sale.status !== 'confirmed') throw new ValidationError('Solo se pueden cancelar ventas confirmadas');

  await prisma.$transaction(async (tx) => {
    // Restore stock
    for (const it of sale.items) {
      await adjustStock(it.variantId, sale.branchId, it.qty, {
        skipTnSync: true,
        tx,
        reason: `Cancel sale ${id}`,
      });
    }
    // Compensating cash movement
    await tx.cashMovement.create({
      data: {
        id: randomId(),
        datetime: new Date(),
        branchId: sale.branchId,
        type: 'adjustment',
        amountIn: 0,
        amountOut: sale.total,
        description: `Cancelaci\u00f3n venta #${sale.number}${opts.reason ? ' - ' + opts.reason : ''}`,
        refId: id,
        userId: opts.userId ?? null,
      },
    });
    await tx.sale.update({ where: { id }, data: { status: 'cancelled' } });
  });

  await logAudit({
    userId: opts.userId,
    action: AUDIT_ACTIONS.SALE_CANCELLED,
    entity: 'sale',
    entityId: id,
    description: opts.reason,
  });

  for (const it of sale.items) {
    await enqueueSync('push_stock', { variantId: it.variantId });
  }
}
