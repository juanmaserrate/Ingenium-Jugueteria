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

  // Atributos de la categoría para un nombre dado: el "nombre de catálogo" required de texto
  // libre (BOARD_GAME_NAME, MODEL, etc.) se completa con ese nombre; el resto es común a todas
  // las variantes. Lo que mande el form (dimensiones del paquete, IVA) siempre gana.
  const buildAttributes = (nameValue: string): any[] => {
    const attrs: any[] = [];
    const have = new Set<string>();
    const put = (id: string, value: any) => {
      if (!id || value == null || value === '' || have.has(id)) return;
      attrs.push({ id, value_name: String(value) });
      have.add(id);
    };
    for (const a of input.attributes || []) put(a.id, a.value_name);
    if (product.brand?.name && byId['BRAND']) put('BRAND', product.brand.name);
    if (byId['VALUE_ADDED_TAX']) put('VALUE_ADDED_TAX', '21%');
    if (byId['IMPORT_DUTY']) put('IMPORT_DUTY', '0%');
    for (const a of catAttrs) {
      if (!isRequiredAttr(a) || have.has(a.id)) continue;
      const openText = (a.value_type === 'string' || a.value_type === 'text')
        && !(a.values && a.values.length) && !a.allowed_units;
      if (openText) put(a.id, nameValue); // BOARD_GAME_NAME, MODEL, etc.
    }
    return attrs;
  };

  // Atributos obligatorios que no pudimos resolver (con lista de valores acotada) → al form.
  // En modo variaciones, el atributo que varía (COLOR/SIZE) se satisface dentro de cada variación.
  const probeHave = new Set(buildAttributes(title).map((a) => a.id));
  const missing = (catAttrs || [])
    .filter((a: any) => isRequiredAttr(a) && !probeHave.has(a.id) && !/^SELLER_PACKAGE_/.test(a.id)
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

  const applyDescription = async (id: string) => {
    if (product.description) { try { await ml.setItemDescription(id, stripHtml(product.description)); } catch { /* no fatal */ } }
  };
  const markPublished = () => prisma.product.update({ where: { id: product.id }, data: { publishedMeli: true } }).catch(() => {});

  // Valor distintivo de una variante: une los valores de sus atributos; si no hay, su nombre.
  const variantValue = (v: any): string => {
    const vals = Object.values((v.attributes as any) || {}).map((x) => String(x).trim()).filter(Boolean);
    return vals.length ? vals.join(' ') : String(v.name || '').trim();
  };
  const baseName = title.slice(0, 48); // deja lugar para " <variante>" dentro de los 60 chars

  // =========================================================================================
  // A) Variaciones agrupadas de ML (una publicación con `title` + variations[]). Son
  //    INCOMPATIBLES con family_name. Solo en categorías no-catálogo (casi nunca en juguetería).
  // =========================================================================================
  if (varyMode) {
    const variationBuild: Array<{ variantId: string; value: string }> = [];
    const variations: any[] = [];
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
    if (variations.length) {
      const r = await createWithLtFallback(() => ({ ...basePayload, attributes: buildAttributes(title), title, variations }));
      if (r.created) {
        const itemId = String(r.created.id);
        await applyDescription(itemId);
        const mapped: string[] = [];
        for (const cv of (r.created.variations || [])) {
          const combo = (cv.attribute_combinations || []).find((c: any) => c.id === mlVarAttr) || (cv.attribute_combinations || [])[0];
          const val = String(combo?.value_name ?? '').trim().toLowerCase();
          const match = variationBuild.find((b) => b.value.trim().toLowerCase() === val);
          if (!match) continue;
          await prisma.variantMeliMapping.upsert({
            where: { variantId: match.variantId },
            update: { mlItemId: itemId, mlVariationId: String(cv.id) },
            create: { variantId: match.variantId, mlItemId: itemId, mlVariationId: String(cv.id) },
          });
          mapped.push(match.variantId);
        }
        await prisma.productMeliMapping.upsert({
          where: { productId: product.id }, update: { mlItemId: itemId }, create: { productId: product.id, mlItemId: itemId },
        }).catch(() => {});
        await markPublished();
        for (const vid of mapped) await enqueueSync('ml_push_stock', { variantId: vid });
        return { ok: true, itemId, permalink: r.created.permalink ?? null, status: r.created.status ?? null, variations: mapped.length, mode: 'variations' };
      }
      // Rechazo típico: categoría de catálogo que no admite variaciones del vendedor. Seguimos
      // con fan-out / item simple — el detalle queda en el log para diagnóstico.
      console.warn('[ml] variaciones rechazadas, sigo con fan-out/simple:', JSON.stringify(r.error?.response?.data ?? r.error?.message));
    }
  }

  // =========================================================================================
  // B) Una publicación por variante (fan-out). >1 variante con ≥2 valores distintos y no vacíos.
  //    En categorías de catálogo ML NO admite variaciones del vendedor, pero SÍ acepta un item
  //    por variante (family_name = nombre + valor). Probado 2026-11-01.
  // =========================================================================================
  const valued = allVariants.map((v) => ({ v, val: variantValue(v) })).filter((x) => x.val);
  const canFanOut = allVariants.length > 1 && valued.length >= 2 && new Set(valued.map((x) => x.val)).size >= 2;
  if (canFanOut) {
    const items: Array<{ variantId: string; itemId: string; value: string; permalink: string | null }> = [];
    const failed: Array<{ variantId: string; value: string; error: any }> = [];
    for (const { v, val } of valued) {
      const famTitle = `${baseName} ${val}`.slice(0, 60).trim();
      const vprice = Number(v.priceOverride ?? product.price);
      if (!vprice || vprice <= 0) { failed.push({ variantId: v.id, value: val, error: 'variante sin precio' }); continue; }
      const qty = await computeMlStockForVariant(v.id);
      const r = await createWithLtFallback(() => ({
        ...basePayload, attributes: buildAttributes(famTitle), family_name: famTitle,
        price: vprice, available_quantity: Math.max(0, Math.round(qty)),
      }));
      if (r.created) {
        const itemId = String(r.created.id);
        await applyDescription(itemId);
        await prisma.variantMeliMapping.upsert({
          where: { variantId: v.id }, update: { mlItemId: itemId, mlVariationId: null },
          create: { variantId: v.id, mlItemId: itemId, mlVariationId: null },
        });
        items.push({ variantId: v.id, itemId, value: val, permalink: r.created.permalink ?? null });
      } else {
        failed.push({ variantId: v.id, value: val, error: r.error?.response?.data ?? r.error?.message });
      }
    }
    if (!items.length) return { error: 'ml_rejected', details: failed.map((f) => f.error) };
    // El mapeo a nivel producto apunta al primer item (representativo: idempotencia + UI).
    await prisma.productMeliMapping.upsert({
      where: { productId: product.id }, update: { mlItemId: items[0].itemId }, create: { productId: product.id, mlItemId: items[0].itemId },
    }).catch(() => {});
    await markPublished();
    for (const it of items) await enqueueSync('ml_push_stock', { variantId: it.variantId });
    return {
      ok: true, itemId: items[0].itemId, permalink: items[0].permalink, mode: 'fanout',
      count: items.length, items, ...(failed.length ? { failed } : {}),
    };
  }

  // =========================================================================================
  // C) Item simple: una sola variante (o sin dimensión distintiva) → family_name = nombre.
  // =========================================================================================
  {
    const r = await createWithLtFallback(() => ({
      ...basePayload, attributes: buildAttributes(input.familyName || title),
      family_name: input.familyName || title, price: Number(price), available_quantity: Math.max(0, Math.round(quantity)),
    }));
    if (!r.created) return { error: 'ml_rejected', details: r.error?.response?.data ?? r.error?.message };
    const itemId = String(r.created.id);
    await applyDescription(itemId);
    await prisma.variantMeliMapping.upsert({
      where: { variantId: variant.id }, update: { mlItemId: itemId, mlVariationId: null },
      create: { variantId: variant.id, mlItemId: itemId, mlVariationId: null },
    });
    await prisma.productMeliMapping.upsert({
      where: { productId: product.id }, update: { mlItemId: itemId }, create: { productId: product.id, mlItemId: itemId },
    }).catch(() => {});
    await markPublished();
    await enqueueSync('ml_push_stock', { variantId: variant.id });
    return { ok: true, itemId, permalink: r.created.permalink ?? null, status: r.created.status ?? null, variations: 0, mode: 'simple' };
  }
}
