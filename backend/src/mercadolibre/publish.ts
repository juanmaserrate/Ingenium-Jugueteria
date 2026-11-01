import { prisma } from '../db.js';
import { requireMlClient } from './client.js';
import { computeMlStockForVariant } from '../services/stock.js';
import { enqueueSync } from '../sync/queue.js';

// Publicación de productos del sistema en Mercado Libre (Fase 3). Es la parte más delicada:
// crea contenido real en la cuenta. NADA se publica solo — lo dispara el usuario desde la UI.
// Si ML rechaza (categoría/atributos obligatorios), se devuelve el error exacto para corregir.

const SITE = 'MLA'; // Argentina

function stripHtml(s: string): string {
  return String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50000);
}

// Predice categorías candidatas a partir del título (domain discovery).
export async function predictCategory(title: string) {
  const ml = await requireMlClient();
  const res = await ml.predictCategory(SITE, title);
  return (Array.isArray(res) ? res : []).map((r: any) => ({
    categoryId: r.category_id, categoryName: r.category_name, domain: r.domain_name ?? r.domain_id ?? null,
  }));
}

export async function publishProduct(input: {
  productId?: string;
  barcode?: string;
  categoryId?: string;
  listingTypeId: string;
  price?: number;
  quantity?: number;
  title?: string;
  condition?: string;
  familyName?: string;
  pictures?: string[]; // URLs extra (p.ej. fotos de TN que no están locales)
  attributes?: Array<{ id: string; value_name: string }>; // atributos obligatorios de la categoría
}) {
  // Resolver la variante a publicar: por productId (la variante default) o por barcode/code.
  let variant;
  if (input.productId) {
    variant = await prisma.variant.findFirst({
      where: { productId: input.productId },
      orderBy: { isDefault: 'desc' },
      include: { product: { include: { images: true, brand: true } } },
    });
  } else if (input.barcode) {
    variant = await prisma.variant.findFirst({
      where: { OR: [{ barcode: input.barcode }, { code: input.barcode }] },
      include: { product: { include: { images: true, brand: true } } },
    });
  }
  if (!variant) return { error: 'not_found', message: 'No se encontró el producto a publicar' };
  const product = variant.product;

  // Idempotencia: si el producto YA está publicado/mapeado en ML, no creamos otra publicación.
  const already = await prisma.productMeliMapping.findUnique({ where: { productId: product.id } });
  if (already) return { ok: true, itemId: already.mlItemId, alreadyLinked: true };

  const title = (input.title || product.name).slice(0, 60); // ML limita el título a 60 chars
  const price = input.price ?? variant.priceOverride ?? product.price;
  if (!price || price <= 0) return { error: 'no_price', message: 'El producto no tiene precio' };
  const quantity = input.quantity ?? (await computeMlStockForVariant(variant.id));

  let categoryId = input.categoryId;
  if (!categoryId) {
    const preds = await predictCategory(title);
    categoryId = preds[0]?.categoryId;
  }
  if (!categoryId) return { error: 'no_category', message: 'No se pudo determinar la categoría; elegila manualmente' };

  const localPics = (product.images || [])
    .slice().sort((a, b) => a.position - b.position)
    .map((im) => im.url)
    .filter(Boolean);
  const extraPics = input.pictures || [];
  const pictures = [...localPics, ...extraPics].map((url) => ({ source: url }));

  const attributes: any[] = [];
  if (product.brand?.name) attributes.push({ id: 'BRAND', value_name: product.brand.name });
  // Atributos obligatorios de la categoría provistos por quien llama (evita duplicar BRAND).
  for (const a of input.attributes || []) {
    if (!attributes.some((x) => x.id === a.id)) attributes.push(a);
  }

  const payload: any = {
    site_id: SITE,
    title,
    category_id: categoryId,
    price: Number(price),
    currency_id: 'ARS',
    available_quantity: Math.max(0, Math.round(quantity)),
    buying_mode: 'buy_it_now',
    listing_type_id: input.listingTypeId,
    condition: input.condition || 'new',
  };
  if (input.familyName) payload.family_name = input.familyName;
  if (pictures.length) payload.pictures = pictures;
  if (attributes.length) payload.attributes = attributes;

  const ml = await requireMlClient();
  let created: any;
  try {
    created = await ml.createItem(payload);
  } catch (err: any) {
    // ML devuelve el detalle de qué falta (categoría/atributos) → se surfacea para corregir.
    return { error: 'ml_rejected', details: err?.response?.data ?? err?.message };
  }

  const itemId = String(created.id);

  // Descripción (best-effort; no frena la publicación si falla).
  if (product.description) {
    try { await ml.setItemDescription(itemId, stripHtml(product.description)); } catch { /* no fatal */ }
  }

  // Mapear + marcar publicado + empujar stock
  await prisma.variantMeliMapping.upsert({
    where: { variantId: variant.id },
    update: { mlItemId: itemId, mlVariationId: null },
    create: { variantId: variant.id, mlItemId: itemId, mlVariationId: null },
  });
  await prisma.productMeliMapping.upsert({
    where: { productId: product.id },
    update: { mlItemId: itemId },
    create: { productId: product.id, mlItemId: itemId },
  }).catch(() => { /* item ya mapeado a otro producto */ });
  await prisma.product.update({ where: { id: product.id }, data: { publishedMeli: true } }).catch(() => {});
  await enqueueSync('ml_push_stock', { variantId: variant.id });

  return { ok: true, itemId, permalink: created.permalink ?? null, status: created.status ?? null };
}
