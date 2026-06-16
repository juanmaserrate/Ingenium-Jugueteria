import { prisma } from '../db.js';
import { NotFoundError } from '../utils/errors.js';
import { logAudit, AUDIT_ACTIONS } from '../utils/audit.js';
import { randomId } from '../utils/crypto.js';
import { enqueueSync } from '../sync/queue.js';

export type ProductInput = {
  id?: string;
  code: string;
  name: string;
  description?: string | null;
  cost?: number;
  marginPct?: number;
  price?: number;
  // Campos extendidos para TN
  promotionalPrice?: number | null;
  weight?: number | null;
  width?: number | null;
  height?: number | null;
  depth?: number | null;
  seoTitle?: string | null;
  seoDescription?: string | null;
  handle?: string | null;
  videoUrl?: string | null;
  tnCategoryIds?: Array<number | string>;
  categoryId?: string | null;
  subcategoryId?: string | null;
  brandId?: string | null;
  supplierId?: string | null;
  publishedTn?: boolean;
  publishedMeli?: boolean;
  active?: boolean;
  // Las variantes se crean con el producto. Si no se especifican, se crea una "default".
  variants?: Array<{
    id?: string;
    name?: string;
    attributes?: Record<string, string>;
    code?: string | null;
    barcode?: string | null;
    priceOverride?: number | null;
    costOverride?: number | null;
    isDefault?: boolean;
    stocks?: Array<{ branchId: string; qty: number }>;
  }>;
};

export async function listProducts() {
  // Solo productos activos: los "borrados" con historial se marcan active=false (soft-delete).
  return prisma.product.findMany({
    where: { active: true },
    include: { variants: { include: { stocks: true } }, images: true, tnMapping: true },
    orderBy: { name: 'asc' },
  });
}

// Alta masiva idempotente (importación del consolidado). Saltea por `code` existente;
// crea producto + variante "default" + stock por sucursal. No toca TN.
export async function bulkCreateProducts(
  items: Array<{ code: string; name?: string; cost?: number; price?: number; marginPct?: number; stocks?: Record<string, number> }>,
  userId?: string,
) {
  const codes = items.map((i) => i.code).filter(Boolean);
  const existing = new Set(
    (await prisma.product.findMany({ where: { code: { in: codes } }, select: { code: true } })).map((p) => p.code),
  );
  let created = 0, skipped = 0;
  for (const it of items) {
    if (!it.code || existing.has(it.code)) { skipped++; continue; }
    const pid = randomId(); const vid = randomId();
    try {
      await prisma.$transaction(async (tx) => {
        await tx.product.create({
          data: { id: pid, code: it.code, name: it.name || it.code, cost: it.cost ?? 0, marginPct: it.marginPct ?? 0, price: it.price ?? 0, active: true },
        });
        await tx.variant.create({ data: { id: vid, productId: pid, name: 'default', attributes: {}, isDefault: true } });
        for (const [branchId, qty] of Object.entries(it.stocks ?? {})) {
          await tx.stock.create({ data: { id: `${vid}|${branchId}`, variantId: vid, branchId, qty: Math.max(0, Math.trunc(Number(qty) || 0)) } });
        }
      });
      existing.add(it.code); created++;
    } catch {
      skipped++;
    }
  }
  return { created, skipped, total: items.length };
}

export async function getProduct(id: string) {
  const p = await prisma.product.findUnique({
    where: { id },
    include: { variants: { include: { stocks: true, tnMapping: true } }, images: true, tnMapping: true },
  });
  if (!p) throw new NotFoundError('Product', id);
  return p;
}

export async function createProduct(data: ProductInput, userId?: string) {
  const id = data.id ?? randomId();
  const variants = data.variants && data.variants.length > 0
    ? data.variants
    : [{ name: 'default', attributes: {}, isDefault: true }];

  const created = await prisma.$transaction(async (tx) => {
    const product = await tx.product.create({
      data: {
        id,
        code: data.code,
        name: data.name,
        description: data.description ?? null,
        cost: data.cost ?? 0,
        marginPct: data.marginPct ?? 0,
        price: data.price ?? 0,
        promotionalPrice: data.promotionalPrice ?? null,
        weight: data.weight ?? null,
        width: data.width ?? null,
        height: data.height ?? null,
        depth: data.depth ?? null,
        seoTitle: data.seoTitle ?? null,
        seoDescription: data.seoDescription ?? null,
        handle: data.handle ?? null,
        videoUrl: data.videoUrl ?? null,
        tnCategoryIds: (data.tnCategoryIds ?? []) as any,
        categoryId: data.categoryId ?? null,
        subcategoryId: data.subcategoryId ?? null,
        brandId: data.brandId ?? null,
        supplierId: data.supplierId ?? null,
        publishedTn: data.publishedTn ?? false,
        publishedMeli: data.publishedMeli ?? false,
        active: data.active ?? true,
      },
    });

    for (const v of variants) {
      const vid = v.id ?? randomId();
      await tx.variant.create({
        data: {
          id: vid,
          productId: product.id,
          name: v.name ?? 'default',
          attributes: (v.attributes ?? {}) as any,
          code: v.code ?? null,
          barcode: v.barcode ?? null,
          priceOverride: v.priceOverride ?? null,
          costOverride: v.costOverride ?? null,
          isDefault: v.isDefault ?? variants.length === 1,
        },
      });
      if (v.stocks) {
        for (const s of v.stocks) {
          await tx.stock.create({
            data: { id: `${vid}|${s.branchId}`, variantId: vid, branchId: s.branchId, qty: s.qty },
          });
        }
      }
    }

    return product;
  });

  await logAudit({
    userId,
    action: AUDIT_ACTIONS.CREATE,
    entity: 'product',
    entityId: created.id,
    after: created,
    description: `Producto creado: ${created.name}`,
  });

  // Si viene marcado como published_tn → encolar creaci\u00f3n en TN
  if (data.publishedTn) {
    await enqueueSync('push_product_create', { productId: created.id });
  }

  return getProduct(created.id);
}

export async function updateProduct(id: string, data: Partial<ProductInput>, userId?: string) {
  const before = await getProduct(id);
  const updated = await prisma.product.update({
    where: { id },
    data: {
      code: data.code ?? undefined,
      name: data.name ?? undefined,
      description: data.description ?? undefined,
      cost: data.cost ?? undefined,
      marginPct: data.marginPct ?? undefined,
      price: data.price ?? undefined,
      promotionalPrice: data.promotionalPrice ?? undefined,
      weight: data.weight ?? undefined,
      width: data.width ?? undefined,
      height: data.height ?? undefined,
      depth: data.depth ?? undefined,
      seoTitle: data.seoTitle ?? undefined,
      seoDescription: data.seoDescription ?? undefined,
      handle: data.handle ?? undefined,
      videoUrl: data.videoUrl ?? undefined,
      tnCategoryIds: data.tnCategoryIds !== undefined ? (data.tnCategoryIds as any) : undefined,
      categoryId: data.categoryId ?? undefined,
      subcategoryId: data.subcategoryId ?? undefined,
      brandId: data.brandId ?? undefined,
      supplierId: data.supplierId ?? undefined,
      publishedTn: data.publishedTn ?? undefined,
      publishedMeli: data.publishedMeli ?? undefined,
      active: data.active ?? undefined,
    },
  });

  await logAudit({
    userId,
    action: AUDIT_ACTIONS.UPDATE,
    entity: 'product',
    entityId: id,
    before,
    after: updated,
    description: `Producto actualizado: ${updated.name}`,
  });

  // Si est\u00e1 publicado o se acaba de publicar → encolar sync
  if (updated.publishedTn) {
    if (!before.publishedTn) {
      await enqueueSync('push_product_create', { productId: id });
    } else {
      await enqueueSync('push_product_update', { productId: id });
    }
  }

  return getProduct(id);
}

export async function deleteProduct(id: string, userId?: string, opts: { keepTn?: boolean } = {}) {
  const before = await getProduct(id);
  // Si est\u00e1 publicado en TN, encolar delete en TN antes de borrar local
  // (salvo keepTn: el usuario eligi\u00f3 "solo del POS" y deja el producto vivo en su tienda).
  if (before.tnMapping && !opts.keepTn) {
    await enqueueSync('push_product_delete', {
      productId: id,
      tnProductId: before.tnMapping.tnProductId,
    });
  }

  // Si el producto tiene historial (ventas o compras), un hard-delete violar\u00eda las FK
  // de SaleItem/PurchaseItem. En ese caso hacemos soft-delete (active=false) para
  // preservar el historial; el listado de productos filtra active=true, as\u00ed desaparece.
  const variantIds = before.variants.map((v) => v.id);
  const [saleCount, purchaseCount] = await Promise.all([
    prisma.saleItem.count({ where: { variantId: { in: variantIds } } }),
    prisma.purchaseItem.count({ where: { variantId: { in: variantIds } } }),
  ]);
  const hasHistory = saleCount > 0 || purchaseCount > 0;

  if (hasHistory) {
    await prisma.product.update({ where: { id }, data: { active: false } });
  } else {
    await prisma.product.delete({ where: { id } });
  }

  await logAudit({
    userId,
    action: AUDIT_ACTIONS.DELETE,
    entity: 'product',
    entityId: id,
    before,
    description: `Producto eliminado: ${before.name}${hasHistory ? ' (soft-delete, tiene historial)' : ''}`,
  });
}

export async function findByBarcode(barcode: string) {
  const variant = await prisma.variant.findFirst({
    where: { OR: [{ barcode }, { code: barcode }] },
    include: { product: true, stocks: true },
  });
  if (variant) return variant;
  const product = await prisma.product.findFirst({
    where: { code: barcode },
    include: { variants: { include: { stocks: true } } },
  });
  return product;
}
