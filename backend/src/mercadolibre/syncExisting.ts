import { prisma } from '../db.js';
import { getMlClient, requireMlClient } from './client.js';
import { enqueueSync } from '../sync/queue.js';
import { computeMlStockForVariant } from '../services/stock.js';
import { matchListings, type MlListing, type MatchRow } from './match.js';

// Sincronizar las publicaciones que YA existen en Mercado Libre con el inventario:
//  1) scanSellerListings  → trae las publicaciones vigentes (activas + pausadas)
//  2) buildSyncPlan       → propone el emparejamiento (no escribe nada)
//  3) applyLinks          → guarda los vínculos confirmados y empuja el stock del sistema
// "Manda el sistema": al vincular, el stock del inventario pisa el de ML. El precio NO se toca.

const skuList = (...vals: unknown[]) => {
  const out: string[] = [];
  for (const v of vals) {
    if (v == null || v === '') continue;
    for (const part of String(v).split(',')) { const s = part.trim(); if (s) out.push(s); }
  }
  return out;
};
const attrSkus = (attrs: any[]) =>
  skuList(...(Array.isArray(attrs) ? attrs : [])
    .filter((a) => a && (a.id === 'SELLER_SKU' || a.id === 'GTIN'))
    .map((a) => a.value_name));

const mlErr = (e: any) => e?.response?.data?.message ?? e?.response?.data?.error ?? e?.message ?? 'error';

// ids de las publicaciones de un estado. ML fue dando de baja variantes de este listado para
// apps nuevas, así que se prueban dos caminos: scan scroll y, si falla, paginado por offset.
async function listItemIds(ml: any, sellerId: string, status: string, via: string[]): Promise<string[]> {
  const ids: string[] = [];
  try {
    let scrollId: string | undefined;
    for (let page = 0; page < 80; page++) { // tope de seguridad: 8000 por estado
      const params: Record<string, any> = { search_type: 'scan', limit: 100, status };
      if (scrollId) params.scroll_id = scrollId;
      const res: any = await ml.searchSellerItems(sellerId, params);
      const batch: string[] = res?.results || [];
      if (!batch.length) break;
      ids.push(...batch.map(String));
      scrollId = res?.scroll_id;
      if (!scrollId) break;
    }
    via.push(`ids:${status}:scan`);
    return ids;
  } catch (scanErr) {
    ids.length = 0;
    try {
      for (let offset = 0; offset < 1000; offset += 50) { // el paginado clásico llega hasta 1000
        const res: any = await ml.searchSellerItems(sellerId, { status, limit: 50, offset });
        const batch: string[] = res?.results || [];
        ids.push(...batch.map(String));
        const total = Number(res?.paging?.total ?? 0);
        if (!batch.length || offset + 50 >= total) break;
      }
      via.push(`ids:${status}:offset`);
      return ids;
    } catch (offErr) {
      throw new Error(`No se pudo listar las publicaciones (${status}): ${mlErr(offErr)} [scan: ${mlErr(scanErr)}]`);
    }
  }
}

// Detalle de las publicaciones: multiget de a 20 y, si ML lo rechaza, de a una (en tandas).
async function fetchItems(ml: any, ids: string[], via: string[]): Promise<any[]> {
  const out: any[] = [];
  let multigetOk = true;
  for (let i = 0; i < ids.length && multigetOk; i += 20) {
    const chunk = ids.slice(i, i + 20);
    try {
      const res: any = await ml.getItemsMulti(chunk, 'id,title,permalink,status,available_quantity,seller_custom_field,attributes,variations');
      for (const row of Array.isArray(res) ? res : []) { const b = row?.body || row; if (b?.id) out.push(b); }
    } catch {
      multigetOk = false;
    }
  }
  if (multigetOk) { via.push('detalle:multiget'); return out; }

  const have = new Set(out.map((b) => String(b.id)));
  const rest = ids.filter((id) => !have.has(id));
  let firstErr: any = null;
  for (let i = 0; i < rest.length; i += 6) {
    const got = await Promise.all(rest.slice(i, i + 6).map((id) => ml.getItem(id).catch((e: any) => { firstErr = firstErr ?? e; return null; })));
    for (const b of got) if (b?.id) out.push(b);
  }
  if (!out.length && firstErr) throw new Error(`No se pudo leer el detalle de las publicaciones: ${mlErr(firstErr)}`);
  via.push('detalle:uno-a-uno');
  return out;
}

export async function scanSellerListings(): Promise<{ listings: MlListing[]; available: boolean; via: string[] }> {
  const via: string[] = [];
  const ml = await getMlClient();
  const integ = await prisma.integration.findUnique({ where: { provider: 'mercadolibre' } });
  const sellerId = integ?.mlUserId;
  if (!ml || !sellerId) return { listings: [], available: false, via };

  // 1) ids de publicaciones vigentes (activas + pausadas).
  const ids = new Set<string>();
  for (const status of ['active', 'paused']) {
    for (const id of await listItemIds(ml, sellerId, status, via)) ids.add(id);
  }

  // 2) detalle.
  const bodies = await fetchItems(ml, [...ids], via);
  const listings: MlListing[] = bodies.map((b: any) => ({
    id: String(b.id),
    title: String(b.title ?? ''),
    permalink: b.permalink ?? null,
    status: String(b.status ?? ''),
    qty: Number(b.available_quantity) || 0,
    skus: [...skuList(b.seller_custom_field), ...attrSkus(b.attributes)],
    variations: (Array.isArray(b.variations) ? b.variations : []).map((v: any) => ({
      id: String(v.id),
      skus: [...skuList(v.seller_custom_field), ...attrSkus(v.attributes)],
      values: (Array.isArray(v.attribute_combinations) ? v.attribute_combinations : [])
        .map((c: any) => String(c?.value_name ?? '').trim()).filter(Boolean),
      qty: Number(v.available_quantity) || 0,
    })),
  }));
  return { listings, available: true, via };
}

export type SyncPlanRow = MatchRow & { systemStock?: number };

export async function buildSyncPlan() {
  const { listings, available, via } = await scanSellerListings();
  if (!available) return { available: false, scanned: 0, via, rows: [] as SyncPlanRow[], counts: { linked: 0, match: 0, unmatched: 0 } };

  const [products, existing] = await Promise.all([
    prisma.product.findMany({
      where: { active: true },
      select: {
        id: true, name: true, code: true,
        variants: { select: { id: true, name: true, barcode: true, code: true, attributes: true, isDefault: true } },
      },
    }),
    prisma.variantMeliMapping.findMany({ select: { variantId: true, mlItemId: true, mlVariationId: true } }),
  ]);

  const rows: SyncPlanRow[] = matchListings(listings, products as any, existing);

  // Stock del sistema de las variantes involucradas (una sola consulta).
  const variantIds = [...new Set(rows.map((r) => r.variantId).filter(Boolean) as string[])];
  if (variantIds.length) {
    const stocks = await prisma.stock.findMany({ where: { variantId: { in: variantIds } }, select: { variantId: true, qty: true, reservedQty: true } });
    const sum = new Map<string, number>();
    for (const s of stocks) sum.set(s.variantId, (sum.get(s.variantId) ?? 0) + Math.max(0, s.qty - s.reservedQty));
    for (const r of rows) if (r.variantId) r.systemStock = sum.get(r.variantId) ?? 0;
  }

  const counts = { linked: 0, match: 0, unmatched: 0 };
  for (const r of rows) counts[r.state]++;
  return { available: true, scanned: listings.length, via, rows, counts };
}

// Guarda vínculos variante ↔ publicación (o variación) y empuja el stock del sistema a ML.
export async function applyLinks(links: Array<{ variantId: string; mlItemId: string; mlVariationId?: string | null }>) {
  let linked = 0;
  const errors: Array<{ variantId: string; mlItemId: string; error: string }> = [];
  for (const l of links) {
    const mlItemId = String(l.mlItemId || '').trim();
    const mlVariationId = l.mlVariationId != null && l.mlVariationId !== '' ? String(l.mlVariationId) : null;
    try {
      const variant = await prisma.variant.findUnique({ where: { id: l.variantId }, select: { id: true, productId: true } });
      if (!variant || !mlItemId) { errors.push({ variantId: l.variantId, mlItemId, error: 'Variante o publicación inválida' }); continue; }

      // La misma publicación/variación no puede quedar en dos variantes.
      const taken = await prisma.variantMeliMapping.findFirst({
        where: { mlItemId, mlVariationId, NOT: { variantId: variant.id } },
      });
      if (taken) { errors.push({ variantId: l.variantId, mlItemId, error: 'Esa publicación ya está vinculada a otro producto' }); continue; }

      await prisma.variantMeliMapping.upsert({
        where: { variantId: variant.id },
        update: { mlItemId, mlVariationId },
        create: { variantId: variant.id, mlItemId, mlVariationId },
      });
      await ensureProductMapping(variant.productId, mlItemId);
      await enqueueSync('ml_push_stock', { variantId: variant.id }); // manda el sistema
      linked++;
    } catch (e: any) {
      errors.push({ variantId: l.variantId, mlItemId, error: e?.message ?? 'error' });
    }
  }
  return { linked, errors };
}

// Mapeo a nivel producto (lo usa la idempotencia de publishProduct y la marca de Inventario).
export async function ensureProductMapping(productId: string, mlItemId: string) {
  const has = await prisma.productMeliMapping.findUnique({ where: { productId } });
  if (!has) {
    // ml_item_id es único: si el item ya representa a otro producto (variaciones repartidas),
    // este producto queda igual marcado por sus variantes.
    await prisma.productMeliMapping.create({ data: { productId, mlItemId } }).catch(() => null);
  }
  await prisma.product.update({ where: { id: productId }, data: { publishedMeli: true } }).catch(() => null);
}

// Desvincula un producto de ML SIN tocar la publicación (sigue viva en ML, deja de sincronizar).
export async function unlinkProduct(productId: string) {
  const variants = await prisma.variant.findMany({ where: { productId }, select: { id: true } });
  const r = await prisma.variantMeliMapping.deleteMany({ where: { variantId: { in: variants.map((v) => v.id) } } });
  await prisma.productMeliMapping.deleteMany({ where: { productId } });
  await prisma.product.update({ where: { id: productId }, data: { publishedMeli: false } }).catch(() => null);
  return { ok: true, removed: r.count };
}

// Estado EN VIVO de las publicaciones de un producto: stock del sistema vs stock real en ML.
export async function productMlStatus(productId: string) {
  const variants = await prisma.variant.findMany({ where: { productId }, select: { id: true, name: true, attributes: true } });
  const maps = await prisma.variantMeliMapping.findMany({ where: { variantId: { in: variants.map((v) => v.id) } } });
  if (!maps.length) return { linked: false, items: [] as any[] };

  const ml = await requireMlClient();
  const itemCache = new Map<string, any>();
  const out: any[] = [];
  for (const m of maps) {
    if (!itemCache.has(m.mlItemId)) {
      try { itemCache.set(m.mlItemId, await ml.getItem(m.mlItemId)); }
      catch (e: any) { itemCache.set(m.mlItemId, { __error: e?.response?.data?.message ?? e?.message ?? 'error' }); }
    }
    const item = itemCache.get(m.mlItemId);
    const v = variants.find((x) => x.id === m.variantId);
    const vals = Object.values((v?.attributes as Record<string, unknown>) || {}).map((x) => String(x ?? '')).filter(Boolean);
    const variation = m.mlVariationId && Array.isArray(item?.variations)
      ? item.variations.find((x: any) => String(x.id) === m.mlVariationId)
      : null;
    out.push({
      variantId: m.variantId,
      variantName: vals.join(' / ') || (v?.name && v.name !== 'default' ? v.name : ''),
      mlItemId: m.mlItemId,
      mlVariationId: m.mlVariationId,
      permalink: item?.permalink ?? null,
      mlStatus: item?.__error ? 'error' : String(item?.status ?? ''),
      mlError: item?.__error ?? null,
      mlQty: item?.__error ? null : Number((variation ?? item)?.available_quantity ?? 0),
      mlPrice: item?.__error ? null : Number((variation ?? item)?.price ?? item?.price ?? 0),
      systemStock: await computeMlStockForVariant(m.variantId),
      lastPushAt: m.lastPushAt,
    });
  }
  return { linked: true, items: out };
}
