import type { Product, Variant } from '@prisma/client';

/**
 * Convierte un producto (+ variantes) de Ingenium al payload esperado por
 * POST /products de Tienda Nube.
 */
export function productToTn(product: Product & { variants: Variant[] }) {
  const promo = product.promotionalPrice && product.promotionalPrice > 0
    ? product.promotionalPrice.toString()
    : null;
  // TN espera weight/dimensions como strings; 0 si no hay valor.
  const w = product.weight ?? 0;
  const wd = product.width ?? 0;
  const h = product.height ?? 0;
  const dp = product.depth ?? 0;

  const variants = product.variants.map((v) => ({
    price: (v.priceOverride ?? product.price).toString(),
    promotional_price: promo,
    stock_management: true,
    stock: 0, // el stock se manda aparte con PUT variants
    weight: w.toString(),
    width: wd.toString(),
    height: h.toString(),
    depth: dp.toString(),
    sku: v.code ?? product.code,
    barcode: v.barcode ?? null,
    values: v.attributes && Object.keys(v.attributes as any).length > 0
      ? Object.values(v.attributes as any).map((val) => ({ es: val }))
      : undefined,
    cost: (v.costOverride ?? product.cost).toString(),
  }));

  const attributes = extractAttributeNames(product.variants);

  // Si hay videoUrl, lo inyectamos en la descripción HTML como embed responsivo.
  const description = product.description ?? '';
  const descriptionWithVideo = product.videoUrl
    ? `${description}\n\n<iframe src="${escapeHtml(toEmbedUrl(product.videoUrl))}" frameborder="0" allowfullscreen style="width:100%;aspect-ratio:16/9;max-width:560px"></iframe>`
    : description;

  const tnCategoryIds = (product.tnCategoryIds as any[] | null) ?? [];
  const categories = tnCategoryIds.length > 0 ? tnCategoryIds.map((n) => Number(n)).filter((n) => !Number.isNaN(n)) : undefined;

  return {
    name: { es: product.name },
    description: descriptionWithVideo ? { es: descriptionWithVideo } : undefined,
    handle: { es: product.handle?.trim() ? product.handle : slugify(product.name) },
    seo_title: product.seoTitle ? { es: product.seoTitle } : undefined,
    seo_description: product.seoDescription ? { es: product.seoDescription } : undefined,
    attributes: attributes.length > 0 ? attributes.map((name) => ({ es: name })) : undefined,
    categories,
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
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

// Acepta URLs de YouTube/Vimeo (watch / shorts / share) y devuelve la URL embed.
function toEmbedUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtube.com')) {
      const v = u.searchParams.get('v');
      if (v) return `https://www.youtube.com/embed/${v}`;
      const m = u.pathname.match(/\/(?:embed|shorts)\/([\w-]+)/);
      if (m) return `https://www.youtube.com/embed/${m[1]}`;
    }
    if (u.hostname === 'youtu.be') {
      return `https://www.youtube.com/embed/${u.pathname.slice(1)}`;
    }
    if (u.hostname.includes('vimeo.com')) {
      const m = u.pathname.match(/\/(\d+)/);
      if (m) return `https://player.vimeo.com/video/${m[1]}`;
    }
  } catch { /* no-op: si no es URL válida, devuelve como vino */ }
  return url;
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
