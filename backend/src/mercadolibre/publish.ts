import { prisma } from '../db.js';
import { requireMlClient } from './client.js';
import { getTnClient } from '../tiendanube/client.js';
import { computeMlStockForVariant } from '../services/stock.js';
import { enqueueSync } from '../sync/queue.js';

// Publicación de productos del sistema en Mercado Libre (Fase 3). Es la parte más delicada:
// crea contenido real en la cuenta. NADA se publica solo — lo dispara el usuario desde la UI.
// Si ML rechaza (categoría/atributos obligatorios), se devuelve el error exacto para corregir.

const SITE = 'MLA'; // Argentina
const FALLBACK_LISTING = 'gold_special'; // "Clásica": sin costo de publicación, siempre disponible

function stripHtml(s: string): string {
  return String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50000);
}

// Fotos: ML exige al menos una. Las del sistema no se espejan (viven en TN), así que si el
// producto no tiene imágenes locales, las traemos de la publicación de Tienda Nube.
async function resolvePictures(product: any, extra: string[]): Promise<string[]> {
  const local = (product.images || [])
    .slice().sort((a: any, b: any) => (a.position ?? 0) - (b.position ?? 0))
    .map((im: any) => im.url).filter(Boolean);
  if (local.length) return [...local, ...extra];
  // Sin fotos locales → intentar las de TN.
  const tnId = product.tnMapping?.tnProductId;
  if (tnId) {
    try {
      const tn = await getTnClient();
      if (tn) {
        const tp: any = await tn.getProduct(tnId);
        const tnPics = (Array.isArray(tp?.images) ? tp.images : [])
          .slice().sort((a: any, b: any) => (a.position ?? 0) - (b.position ?? 0))
          .map((im: any) => im.src).filter(Boolean);
        return [...tnPics, ...extra];
      }
    } catch { /* si TN falla, seguimos con lo que haya */ }
  }
  return [...extra];
}

const isRequiredAttr = (a: any) =>
  !!(a?.tags && (a.tags.required || a.tags.catalog_required || a.tags.fixed));

// Mapea la clave de variante local (texto libre) al atributo de variación de ML.
// Solo estas dimensiones se pueden variar; cualquier otra (p.ej. "Modelo") no es variable en ML.
function mapVariationAttr(key: string): string | null {
  if (/color/i.test(key)) return 'COLOR';
  if (/talle|talla|size|medida/i.test(key)) return 'SIZE';
  return null;
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
  const include = { product: { include: { images: true, brand: true, tnMapping: true } } };
  if (input.productId) {
    variant = await prisma.variant.findFirst({
      where: { productId: input.productId },
      orderBy: { isDefault: 'desc' },
      include,
    });
  } else if (input.barcode) {
    variant = await prisma.variant.findFirst({
      where: { OR: [{ barcode: input.barcode }, { code: input.barcode }] },
      include,
    });
  }
  if (!variant) return { error: 'not_found', message: 'No se encontró el producto a publicar' };
  const product = variant.product;
  const allVariants = await prisma.variant.findMany({ where: { productId: product.id } });

  // ¿Se puede publicar con variaciones de ML? Requiere >1 variante, una sola dimensión
  // (ej. "Color") que mapee a un atributo de variación (COLOR/SIZE). Se confirma más abajo
  // contra la categoría (allow_variations). Si no, se publica la variante default como item simple.
  const varKeys = new Set<string>();
  for (const v of allVariants) for (const k of Object.keys((v.attributes as any) || {})) varKeys.add(k);
  const varKey = [...varKeys].find((k) => mapVariationAttr(k)) ?? null;
  const mlVarAttr = varKey ? mapVariationAttr(varKey) : null;
  const canVary = allVariants.length > 1 && varKeys.size === 1 && !!mlVarAttr;

  // Idempotencia: si el producto YA está publicado/mapeado en ML, no creamos otra publicación.
  const already = await prisma.productMeliMapping.findUnique({ where: { productId: product.id } });
  if (already) return { ok: true, itemId: already.mlItemId, alreadyLinked: true };

  const title = (input.title || product.name).slice(0, 60); // ML limita el título a 60 chars
  const price = input.price ?? variant.priceOverride ?? product.price;
  if (!price || price <= 0) return { error: 'no_price', message: 'El producto no tiene precio' };
  const quantity = input.quantity ?? (await computeMlStockForVariant(variant.id));

  const ml = await requireMlClient();

  let categoryId = input.categoryId;
  if (!categoryId) {
    const preds = await predictCategory(title);
    categoryId = preds[0]?.categoryId;
  }
  if (!categoryId) return { error: 'no_category', message: 'No se pudo determinar la categoría; elegila manualmente' };

  // Fotos (local o, en su defecto, de TN). ML rechaza sin al menos una.
  const picUrls = await resolvePictures(product, input.pictures || []);
  if (!picUrls.length) {
    return { error: 'no_picture', message: 'El producto no tiene foto. Subí una imagen al producto o publicalo primero en Tienda Nube.' };
  }
  const pictures = picUrls.map((url) => ({ source: url }));

  // Atributos de la categoría: traemos el esquema para saber cuáles existen/son obligatorios
  // y auto-completar lo que podemos (marca, IVA, derecho de importación, nombre de catálogo).
  let catAttrs: any[] = [];
  try { catAttrs = await ml.getCategoryAttributes(categoryId); } catch { /* seguimos sin esquema */ }
  const byId: Record<string, any> = Object.fromEntries((catAttrs || []).map((a: any) => [a.id, a]));

  // Variaciones: solo si la categoría marca el atributo como variable (allow_variations).
  const varyMode = canVary && !!(byId[mlVarAttr!]?.tags?.allow_variations);

  const attributes: any[] = [];
  const have = new Set<string>();
  const put = (id: string, value: any) => {
    if (!id || value == null || value === '' || have.has(id)) return;
    attributes.push({ id, value_name: String(value) });
    have.add(id);
  };
  // 1) Lo que mande el form gana (dimensiones del paquete, overrides, etc.).
  for (const a of input.attributes || []) put(a.id, a.value_name);
  // 2) Auto-relleno de atributos universales si la categoría los declara.
  if (product.brand?.name && byId['BRAND']) put('BRAND', product.brand.name);
  if (byId['VALUE_ADDED_TAX']) put('VALUE_ADDED_TAX', '21%');
  if (byId['IMPORT_DUTY']) put('IMPORT_DUTY', '0%');
  // 3) Nombre de catálogo obligatorio y de texto libre (BOARD_GAME_NAME, etc.) → nombre del producto.
  for (const a of catAttrs) {
    if (!isRequiredAttr(a) || have.has(a.id)) continue;
    const openText = (a.value_type === 'string' || a.value_type === 'text')
      && !(a.values && a.values.length) && !a.allowed_units;
    if (openText && /_NAME$/.test(a.id)) put(a.id, title);
  }

  // Atributos obligatorios que no pudimos resolver (con lista de valores acotada) → al form.
  // En modo variaciones, el atributo que varía (COLOR/SIZE) se satisface dentro de cada variación.
  const missing = (catAttrs || [])
    .filter((a: any) => isRequiredAttr(a) && !have.has(a.id) && !/^SELLER_PACKAGE_/.test(a.id)
      && !(varyMode && a.id === mlVarAttr))
    .map((a: any) => ({
      id: a.id, name: a.name, valueType: a.value_type,
      values: (a.values || []).slice(0, 40).map((v: any) => ({ id: v.id, name: v.name })),
    }));
  if (missing.length) {
    return { error: 'missing_attributes', missing, categoryId, familyName: input.familyName || title };
  }

  const basePayload: any = {
    site_id: SITE,
    category_id: categoryId,
    currency_id: 'ARS',
    buying_mode: 'buy_it_now',
    condition: input.condition || 'new',
    pictures,
  };
  if (attributes.length) basePayload.attributes = attributes;

  // Dos formas de listar: con variaciones del vendedor (publicación propia, con `title`) o como
  // item simple por familia de catálogo (`family_name`, sin title). Son INCOMPATIBLES entre sí.
  const variationBuild: Array<{ variantId: string; value: string }> = [];
  const variations: any[] = [];
  if (varyMode) {
    for (const v of allVariants) {
      const value = String((v.attributes as any)?.[varKey!] ?? '').trim();
      if (!value) continue;
      const qty = await computeMlStockForVariant(v.id);
      variations.push({
        attribute_combinations: [{ id: mlVarAttr, value_name: value }],
        available_quantity: Math.max(0, Math.round(qty)),
        price: Number(v.priceOverride ?? product.price),
      });
      variationBuild.push({ variantId: v.id, value });
    }
  }
  const variationPayload = () => ({ ...basePayload, title, variations });
  const simplePayload = () => ({
    ...basePayload,
    family_name: input.familyName || title,
    price: Number(price),
    available_quantity: Math.max(0, Math.round(quantity)),
  });

  // Crear, reintentando con Clásica si el tipo de publicación no está disponible en la categoría.
  const createWithLtFallback = async (build: (lt: string) => any): Promise<{ created?: any; error?: any }> => {
    try { return { created: await ml.createItem({ ...build(input.listingTypeId), listing_type_id: input.listingTypeId }) }; }
    catch (err: any) {
      const causes: any[] = err?.response?.data?.cause ?? [];
      if (causes.some((c) => c?.code === 'item.listing_type_id.unavailable') && input.listingTypeId !== FALLBACK_LISTING) {
        try { return { created: await ml.createItem({ ...build(FALLBACK_LISTING), listing_type_id: FALLBACK_LISTING }) }; }
        catch (e2: any) { return { error: e2 }; }
      }
      return { error: err };
    }
  };

  let created: any = null;
  let usedVariations = false;
  if (varyMode && variations.length) {
    const r = await createWithLtFallback(variationPayload);
    if (r.created) { created = r.created; usedVariations = true; }
    // Si falla (típico: categoría de catálogo que no admite variaciones del vendedor) caemos a
    // item simple — preferimos dejar una publicación válida antes que un error. El detalle del
    // rechazo de variaciones queda en el log para diagnóstico.
    else console.warn('[ml] variaciones rechazadas, fallback a item simple:', JSON.stringify(r.error?.response?.data ?? r.error?.message));
  }
  if (!created) {
    const r = await createWithLtFallback(simplePayload);
    if (r.created) { created = r.created; usedVariations = false; }
    else return { error: 'ml_rejected', details: r.error?.response?.data ?? r.error?.message };
  }

  const itemId = String(created.id);

  // Descripción (best-effort; no frena la publicación si falla).
  if (product.description) {
    try { await ml.setItemDescription(itemId, stripHtml(product.description)); } catch { /* no fatal */ }
  }

  // Mapear + marcar publicado + empujar stock
  let mappedVariants: string[] = [];
  if (usedVariations && Array.isArray(created.variations) && created.variations.length) {
    // Emparejar cada variación creada con la variante local por el valor del atributo.
    for (const cv of created.variations) {
      const combo = (cv.attribute_combinations || []).find((c: any) => c.id === mlVarAttr) || (cv.attribute_combinations || [])[0];
      const val = String(combo?.value_name ?? '').trim().toLowerCase();
      const match = variationBuild.find((b) => b.value.trim().toLowerCase() === val);
      if (!match) continue;
      await prisma.variantMeliMapping.upsert({
        where: { variantId: match.variantId },
        update: { mlItemId: itemId, mlVariationId: String(cv.id) },
        create: { variantId: match.variantId, mlItemId: itemId, mlVariationId: String(cv.id) },
      });
      mappedVariants.push(match.variantId);
    }
  } else {
    await prisma.variantMeliMapping.upsert({
      where: { variantId: variant.id },
      update: { mlItemId: itemId, mlVariationId: null },
      create: { variantId: variant.id, mlItemId: itemId, mlVariationId: null },
    });
    mappedVariants.push(variant.id);
  }
  await prisma.productMeliMapping.upsert({
    where: { productId: product.id },
    update: { mlItemId: itemId },
    create: { productId: product.id, mlItemId: itemId },
  }).catch(() => { /* item ya mapeado a otro producto */ });
  await prisma.product.update({ where: { id: product.id }, data: { publishedMeli: true } }).catch(() => {});
  for (const vid of mappedVariants) await enqueueSync('ml_push_stock', { variantId: vid });

  return {
    ok: true, itemId, permalink: created.permalink ?? null, status: created.status ?? null,
    variations: usedVariations ? mappedVariants.length : 0,
    mode: usedVariations ? 'variations' : 'simple',
  };
}
