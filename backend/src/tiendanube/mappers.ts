import type { Product, Variant } from '@prisma/client';

/**
 * Convierte un producto (+ variantes) de Ingenium al payload esperado por
 * POST /products de Tienda Nube.
 */
export function productToTn(product: Product & { variants: Variant[] }) {
  // TN requiere al menos una variante. Si no hay variantes "reales", manda una simple.
  const variants = product.variants.map((v) => ({
    price: (v.priceOverride ?? product.price).toString(),
    promotional_price: null,
    stock_management: true,
    stock: 0, // el stock se manda aparte con PUT variants
    weight: '0',
    width: '0',
    height: '0',
    depth: '0',
    sku: v.code ?? product.code,
    barcode: v.barcode ?? null,
    values: v.attributes && Object.keys(v.attributes as any).length > 0
      ? Object.values(v.attributes as any).map((val) => ({ es: val }))
      : undefined,
    cost: (v.costOverride ?? product.cost).toString(),
  }));

  const attributes = extractAttributeNames(product.variants);

  return {
    name: { es: product.name },
    description: product.description ? { es: product.description } : undefined,
    handle: { es: slugify(product.name) },
    attributes: attributes.length > 0 ? attributes.map((name) => ({ es: name })) : undefined,
    variants,
    published: product.active,
  };
}

export function variantToTn(variant: Variant, fallbackPrice: number, fallbackCost: number) {
  return {
    price: (variant.priceOverride ?? fallbackPrice).toString(),
    stock_management: true,
    stock: 0,
    sku: variant.code ?? null,
    barcode: variant.barcode ?? null,
    cost: (variant.costOverride ?? fallbackCost).toString(),
    values: variant.attributes && Object.keys(variant.attributes as any).length > 0
      ? Object.values(variant.attributes as any).map((val) => ({ es: val }))
      : undefined,
  };
}

function extractAttributeNames(variants: Variant[]): string[] {
  const names = new Set<string>();
  for (const v of variants) {
    for (const k of Object.keys((v.attributes as any) ?? {})) names.add(k);
  }
  return [...names];
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Convierte una orden de TN al input interno para crear una Sale.
 * Requiere que todos los items tengan mapping local.
 */
export function tnOrderToItemsInput(
  tnOrder: any,
  variantMappings: Map<string, string>, // tnVariantId -> variantId local
): { items: Array<{ variantId: string; qty: number; unitPrice: number }>; unmapped: any[] } {
  const items: Array<{ variantId: string; qty: number; unitPrice: number }> = [];
  const unmapped: any[] = [];
  for (const line of tnOrder.products ?? []) {
    const tnVariantId = String(line.variant_id);
    const variantId = variantMappings.get(tnVariantId);
    if (!variantId) {
      unmapped.push(line);
      continue;
    }
    items.push({
      variantId,
      qty: line.quantity,
      unitPrice: parseFloat(line.price),
    });
  }
  return { items, unmapped };
}
