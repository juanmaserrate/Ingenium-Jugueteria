import { prisma } from '../db.js';
import { randomId } from '../utils/crypto.js';
import { nextYearlyCounter } from './counters.js';
import { logAudit, AUDIT_ACTIONS } from '../utils/audit.js';
import { NotFoundError, ValidationError, ConflictError } from '../utils/errors.js';

export type PurchaseItemInput = {
  id?: string;
  variantId?: string | null;
  productId?: string | null;
  matchType?: string;
  rawName: string;
  barcode?: string | null;
  sku?: string | null;
  qtyOrdered: number;
  unitCost: number;
  marginPct?: number;
  salePrice: number;
  qtyLomas?: number;
  qtyBanfield?: number;
  tnConfig?: unknown;
  publishTn?: boolean;
};

export type PurchaseHeaderInput = {
  branchId: string;
  supplierId?: string | null;
  invoiceType?: string; // "A" | "X"
  invoiceNumber?: string | null;
  marginPctDefault?: number;
  notes?: string | null;
};

function computeTotals(items: PurchaseItemInput[]) {
  const itemsCount = items.length;
  const totalCost = items.reduce((s, it) => s + (Number(it.unitCost) || 0) * (Number(it.qtyOrdered) || 0), 0);
  return { itemsCount, totalCost: Number(totalCost.toFixed(2)) };
}

export async function listPurchases(status?: string) {
  return prisma.purchase.findMany({
    where: status ? { status } : undefined,
    include: { supplier: true, _count: { select: { items: true } } },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getPurchase(id: string) {
  const p = await prisma.purchase.findUnique({
    where: { id },
    include: {
      supplier: true,
      branch: true,
      items: { orderBy: { createdAt: 'asc' } },
      documents: { orderBy: { createdAt: 'asc' } },
    },
  });
  if (!p) throw new NotFoundError('Purchase', id);
  return p;
}

export async function createPurchase(input: PurchaseHeaderInput, userId?: string) {
  if (!input.branchId) throw new ValidationError('branchId requerido');
  const id = randomId();
  const number = await nextYearlyCounter(`purchase_${input.branchId}`);
  const created = await prisma.purchase.create({
    data: {
      id,
      number,
      branchId: input.branchId,
      supplierId: input.supplierId ?? null,
      invoiceType: input.invoiceType === 'X' ? 'X' : 'A',
      invoiceNumber: input.invoiceNumber ?? null,
      marginPctDefault: input.marginPctDefault ?? 100,
      notes: input.notes ?? null,
      status: 'draft',
      scanStatus: 'none',
      userId: userId ?? null,
    },
  });
  await logAudit({
    userId,
    action: AUDIT_ACTIONS.CREATE,
    entity: 'compra',
    entityId: created.id,
    after: created,
    description: `Compra #${number} creada (borrador)`,
  });
  return getPurchase(created.id);
}

export async function updatePurchase(
  id: string,
  input: PurchaseHeaderInput & { items?: PurchaseItemInput[] },
  userId?: string,
) {
  const before = await getPurchase(id);
  if (before.status !== 'draft' && before.status !== 'pending') {
    throw new ConflictError('Solo se puede editar una compra en borrador o pendiente');
  }

  const items = input.items ?? before.items.map((it) => ({
    rawName: it.rawName,
    variantId: it.variantId,
    productId: it.productId,
    matchType: it.matchType,
    barcode: it.barcode,
    sku: it.sku,
    qtyOrdered: it.qtyOrdered,
    unitCost: it.unitCost,
    marginPct: it.marginPct,
    salePrice: it.salePrice,
    qtyLomas: it.qtyLomas,
    qtyBanfield: it.qtyBanfield,
    tnConfig: it.tnConfig,
    publishTn: it.publishTn,
  } as PurchaseItemInput));

  const { itemsCount, totalCost } = computeTotals(items);

  const updated = await prisma.$transaction(async (tx) => {
    await tx.purchase.update({
      where: { id },
      data: {
        supplierId: input.supplierId ?? undefined,
        invoiceType: input.invoiceType ? (input.invoiceType === 'X' ? 'X' : 'A') : undefined,
        invoiceNumber: input.invoiceNumber ?? undefined,
        marginPctDefault: input.marginPctDefault ?? undefined,
        notes: input.notes ?? undefined,
        itemsCount,
        totalCost,
      },
    });
    // Si vienen items, reemplazamos el set completo (más simple y predecible que diff).
    if (input.items) {
      await tx.purchaseItem.deleteMany({ where: { purchaseId: id } });
      for (const it of input.items) {
        await tx.purchaseItem.create({
          data: {
            id: randomId(),
            purchaseId: id,
            variantId: it.variantId ?? null,
            productId: it.productId ?? null,
            matchType: it.matchType ?? 'unmatched',
            rawName: it.rawName,
            barcode: it.barcode ?? null,
            sku: it.sku ?? null,
            qtyOrdered: Math.max(0, Math.trunc(Number(it.qtyOrdered) || 0)),
            unitCost: Number(it.unitCost) || 0,
            marginPct: Number(it.marginPct ?? before.marginPctDefault) || 0,
            salePrice: Number(it.salePrice) || 0,
            qtyLomas: Math.max(0, Math.trunc(Number(it.qtyLomas) || 0)),
            qtyBanfield: Math.max(0, Math.trunc(Number(it.qtyBanfield) || 0)),
            tnConfig: (it.tnConfig ?? null) as any,
            publishTn: !!it.publishTn,
          },
        });
      }
    }
    return tx.purchase.findUnique({ where: { id } });
  });

  await logAudit({
    userId,
    action: AUDIT_ACTIONS.UPDATE,
    entity: 'compra',
    entityId: id,
    after: updated,
    description: `Compra #${before.number} actualizada (${itemsCount} items)`,
  });
  return getPurchase(id);
}

export async function setPurchaseStatus(id: string, status: string, userId?: string) {
  const before = await getPurchase(id);

  if (status === 'pending') {
    if (before.status !== 'draft') throw new ConflictError('Solo un borrador puede pasar a pendiente');
    if (before.items.length === 0) throw new ValidationError('La compra no tiene items');
    const bad = before.items.find((it) => it.qtyOrdered <= 0 || it.unitCost <= 0);
    if (bad) throw new ValidationError(`Item "${bad.rawName}" requiere cantidad y costo mayores a 0`);
  } else if (status === 'cancelled') {
    if (before.status === 'received') throw new ConflictError('No se puede cancelar una compra ya recibida');
  } else {
    throw new ValidationError(`Transición de estado no soportada: ${status}`);
  }

  await prisma.purchase.update({ where: { id }, data: { status } });
  await logAudit({
    userId,
    action: AUDIT_ACTIONS.UPDATE,
    entity: 'compra',
    entityId: id,
    description: `Compra #${before.number} → ${status}`,
  });
  return getPurchase(id);
}

export async function deletePurchase(id: string, userId?: string) {
  const before = await getPurchase(id);
  if (before.status !== 'draft') throw new ConflictError('Solo se puede borrar un borrador');
  await prisma.purchase.delete({ where: { id } });
  await logAudit({
    userId,
    action: AUDIT_ACTIONS.DELETE,
    entity: 'compra',
    entityId: id,
    before,
    description: `Compra #${before.number} borrada`,
  });
}
