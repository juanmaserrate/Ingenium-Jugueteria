import { prisma } from '../db.js';
import { NotFoundError } from '../utils/errors.js';
import { logAudit, AUDIT_ACTIONS } from '../utils/audit.js';
import { randomId } from '../utils/crypto.js';
import { enqueueSync } from '../sync/queue.js';

export type VariantInput = {
  productId: string;
  name: string;
  attributes?: Record<string, string>;
  code?: string | null;
  barcode?: string | null;
  priceOverride?: number | null;
  costOverride?: number | null;
};

export async function listVariants(productId: string) {
  return prisma.variant.findMany({
    where: { productId },
    include: { stocks: true, tnMapping: true },
    orderBy: { createdAt: 'asc' },
  });
}

export async function createVariant(data: VariantInput, userId?: string) {
  const id = randomId();
  const variant = await prisma.variant.create({
    data: {
      id,
      productId: data.productId,
      name: data.name,
      attributes: (data.attributes ?? {}) as any,
      code: data.code ?? null,
      barcode: data.barcode ?? null,
      priceOverride: data.priceOverride ?? null,
      costOverride: data.costOverride ?? null,
      isDefault: false,
    },
  });

  // Crear registros de stock en 0 para cada sucursal existente
  const branches = await prisma.branch.findMany();
  for (const b of branches) {
    await prisma.stock.create({
      data: { id: `${id}|${b.id}`, variantId: id, branchId: b.id, qty: 0 },
    });
  }

  await logAudit({
    userId,
    action: AUDIT_ACTIONS.CREATE,
    entity: 'variant',
    entityId: id,
    after: variant,
  });

  const product = await prisma.product.findUnique({ where: { id: data.productId } });
  if (product?.publishedTn) {
    await enqueueSync('push_variant_create', { variantId: id });
  }

  return variant;
}

export async function updateVariant(id: string, data: Partial<VariantInput>, userId?: string) {
  const before = await prisma.variant.findUnique({ where: { id } });
  if (!before) throw new NotFoundError('Variant', id);

  const updated = await prisma.variant.update({
    where: { id },
    data: {
      name: data.name ?? undefined,
      attributes: data.attributes as any ?? undefined,
      code: data.code ?? undefined,
      barcode: data.barcode ?? undefined,
      priceOverride: data.priceOverride ?? undefined,
      costOverride: data.costOverride ?? undefined,
    },
  });

  await logAudit({ userId, action: AUDIT_ACTIONS.UPDATE, entity: 'variant', entityId: id, before, after: updated });

  const product = await prisma.product.findUnique({ where: { id: before.productId } });
  if (product?.publishedTn) {
    await enqueueSync('push_variant_update', { variantId: id });
  }
  return updated;
}

export async function deleteVariant(id: string, userId?: string) {
  const before = await prisma.variant.findUnique({ where: { id }, include: { tnMapping: true } });
  if (!before) throw new NotFoundError('Variant', id);
  if (before.tnMapping) {
    await enqueueSync('push_variant_delete', {
      variantId: id,
      tnProductId: before.tnMapping.tnProductId,
      tnVariantId: before.tnMapping.tnVariantId,
    });
  }
  await prisma.variant.delete({ where: { id } });
  await logAudit({ userId, action: AUDIT_ACTIONS.DELETE, entity: 'variant', entityId: id, before });
}
