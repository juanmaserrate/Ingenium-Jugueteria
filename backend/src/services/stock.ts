import { prisma } from '../db.js';
import { Prisma } from '@prisma/client';
import { StockInsufficientError } from '../utils/errors.js';
import { logAudit, AUDIT_ACTIONS } from '../utils/audit.js';
import { enqueueSync } from '../sync/queue.js';

/**
 * Stock publicado en TN: suma de (qty - reservedQty) de todas las sucursales
 * habilitadas por la configuraci\u00f3n. Modo actual: 'sum' (Lomas + Banfield).
 */
export async function computeTnStockForVariant(variantId: string): Promise<number> {
  const integration = await prisma.integration.findUnique({ where: { provider: 'tiendanube' } });
  const mode = integration?.stockMode ?? 'sum';
  const stocks = await prisma.stock.findMany({ where: { variantId } });
  if (stocks.length === 0) return 0;

  if (mode === 'sum') {
    return stocks.reduce((sum, s) => sum + Math.max(0, s.qty - s.reservedQty), 0);
  }
  // modo 'lomas' o 'banfield' → solo esa sucursal
  const target = stocks.find((s) => s.branchId === mode);
  return target ? Math.max(0, target.qty - target.reservedQty) : 0;
}

export async function getStock(variantId: string, branchId: string) {
  return prisma.stock.findUnique({
    where: { variantId_branchId: { variantId, branchId } },
  });
}

export async function setStock(
  variantId: string,
  branchId: string,
  qty: number,
  opts: { userId?: string; reason?: string; skipTnSync?: boolean } = {},
) {
  const id = `${variantId}|${branchId}`;
  const before = await prisma.stock.findUnique({ where: { id } });

  const after = await prisma.stock.upsert({
    where: { id },
    update: { qty },
    create: { id, variantId, branchId, qty },
  });

  await logAudit({
    userId: opts.userId,
    action: AUDIT_ACTIONS.STOCK_ADJUSTED,
    entity: 'stock',
    entityId: id,
    before,
    after,
    description: opts.reason ?? `Stock ajustado a ${qty}`,
  });

  if (!opts.skipTnSync) {
    await enqueueSync('push_stock', { variantId });
  }
  return after;
}

export async function adjustStock(
  variantId: string,
  branchId: string,
  delta: number,
  opts: { userId?: string; reason?: string; skipTnSync?: boolean; tx?: Prisma.TransactionClient } = {},
) {
  const client = opts.tx ?? prisma;
  const id = `${variantId}|${branchId}`;
  const current = await client.stock.findUnique({ where: { id } });
  const newQty = (current?.qty ?? 0) + delta;

  const after = await client.stock.upsert({
    where: { id },
    update: { qty: newQty },
    create: { id, variantId, branchId, qty: newQty },
  });

  if (!opts.tx) {
    await logAudit({
      userId: opts.userId,
      action: AUDIT_ACTIONS.STOCK_ADJUSTED,
      entity: 'stock',
      entityId: id,
      before: current,
      after,
      description: opts.reason ?? `delta ${delta}`,
    });
    if (!opts.skipTnSync) await enqueueSync('push_stock', { variantId });
  }
  return after;
}

export async function reserveStock(variantId: string, branchId: string, qty: number, tx?: Prisma.TransactionClient) {
  const client = tx ?? prisma;
  const id = `${variantId}|${branchId}`;
  const s = await client.stock.findUnique({ where: { id } });
  const available = (s?.qty ?? 0) - (s?.reservedQty ?? 0);
  if (available < qty) throw new StockInsufficientError(variantId, branchId, available, qty);
  await client.stock.update({
    where: { id },
    data: { reservedQty: (s?.reservedQty ?? 0) + qty },
  });
}

export async function releaseReserved(variantId: string, branchId: string, qty: number, tx?: Prisma.TransactionClient) {
  const client = tx ?? prisma;
  const id = `${variantId}|${branchId}`;
  const s = await client.stock.findUnique({ where: { id } });
  if (!s) return;
  await client.stock.update({
    where: { id },
    data: { reservedQty: Math.max(0, s.reservedQty - qty) },
  });
}

export async function transferStock(input: {
  variantId: string;
  fromBranch: string;
  toBranch: string;
  qty: number;
  userId?: string;
}) {
  const { variantId, fromBranch, toBranch, qty, userId } = input;
  return prisma.$transaction(async (tx) => {
    await adjustStock(variantId, fromBranch, -qty, { userId, reason: `Transfer to ${toBranch}`, skipTnSync: true, tx });
    await adjustStock(variantId, toBranch, qty, { userId, reason: `Transfer from ${fromBranch}`, skipTnSync: true, tx });
    await enqueueSync('push_stock', { variantId });
  });
}
