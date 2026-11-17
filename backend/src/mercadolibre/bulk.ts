import { prisma } from '../db.js';
import { getMlClient } from './client.js';
import { computeMlStockForVariant } from '../services/stock.js';

// Publicación en LOTE por categoría. NO publica nada: solo arma el PLAN (dry-run) que
// la UI muestra para que el usuario confirme. La ejecución reusa los endpoints de a uno
// (/publish y /link) desde el front, con progreso. Esto detecta publicaciones que YA
// existen en ML (por SKU o título) para VINCULARLAS en vez de duplicarlas.

const normSku = (s: string) => String(s || '').trim().toUpperCase().replace(/\s+/g, '');
const normTitle = (s: string) =>
  String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();

export type SellerScan = { bySku: Map<string, string>; byTitle: Map<string, string>; scanned: number; available: boolean };

// Trae TODAS las publicaciones activas del vendedor y las indexa por SKU y por título.
export async function scanSellerListings(): Promise<SellerScan> {
  const bySku = new Map<string, string>();
  const byTitle = new Map<string, string>();
  const ml = await getMlClient();
  const integ = await prisma.integration.findUnique({ where: { provider: 'mercadolibre' } });
  const sellerId = integ?.mlUserId;
  if (!ml || !sellerId) return { bySku, byTitle, scanned: 0, available: false };

  // 1) Juntar ids con scan scroll (soporta cualquier cantidad de publicaciones).
  const ids: string[] = [];
  let scrollId: string | undefined;
  for (let page = 0; page < 60; page++) { // tope de seguridad: 60 * 100 = 6000
    const params: Record<string, any> = { search_type: 'scan', limit: 100 };
    if (scrollId) params.scroll_id = scrollId;
    let res: any;
    try { res = await ml.searchSellerItems(sellerId, params); } catch { break; }
    const batch: string[] = res?.results || [];
    if (!batch.length) break;
    ids.push(...batch);
    scrollId = res?.scroll_id;
    if (!scrollId) break;
  }

  // 2) Multiget en lotes de 20 → SKU (seller_custom_field / SELLER_SKU / GTIN) y título.
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    let res: any;
    try { res = await ml.getItemsMulti(chunk, 'id,title,seller_custom_field,attributes'); } catch { continue; }
    for (const row of (Array.isArray(res) ? res : [])) {
      const body = row?.body || row;
      if (!body?.id) continue;
      const itemId = String(body.id);
      const skus = new Set<string>();
      if (body.seller_custom_field) skus.add(String(body.seller_custom_field));
      for (const a of (body.attributes || [])) {
        if ((a.id === 'SELLER_SKU' || a.id === 'GTIN') && a.value_name) skus.add(String(a.value_name));
      }
      for (const sk of skus) { const n = normSku(sk); if (n && !bySku.has(n)) bySku.set(n, itemId); }
      const nt = normTitle(body.title || '');
      if (nt && !byTitle.has(nt)) byTitle.set(nt, itemId);
    }
  }
  return { bySku, byTitle, scanned: ids.length, available: true };
}

export type PlanItem = {
  productId: string; name: string; categoryName: string;
  stock: number; price: number; hasPhoto: boolean; variantsCount: number;
  status: 'linked' | 'match' | 'new' | 'skip';
  reason?: string; mlItemId?: string; matchBy?: 'sku' | 'title'; linkBarcode?: string | null;
};

export async function buildBulkPlan(opts: { categoryIds?: string[]; subcategoryIds?: string[]; includeZeroStock?: boolean }) {
  const ors: any[] = [];
  if (opts.categoryIds?.length) ors.push({ categoryId: { in: opts.categoryIds } });
  if (opts.subcategoryIds?.length) ors.push({ subcategoryId: { in: opts.subcategoryIds } });
  if (!ors.length) return { items: [] as PlanItem[], scan: { available: false, scanned: 0 } };

  const products = await prisma.product.findMany({
    where: { OR: ors },
    include: { images: true, tnMapping: true, mlMapping: true, category: true, variants: true },
    orderBy: { name: 'asc' },
  });

  // Escaneo de ML (best-effort). Si falla, el plan sigue y todo queda como 'new'.
  const scan = await scanSellerListings().catch(() => ({ bySku: new Map(), byTitle: new Map(), scanned: 0, available: false } as SellerScan));

  const items: PlanItem[] = [];
  for (const p of products) {
    let stock = 0;
    for (const v of p.variants) stock += await computeMlStockForVariant(v.id);
    const price = p.price || 0;
    const hasPhoto = (p.images?.length || 0) > 0 || !!p.tnMapping?.tnProductId;
    const def = p.variants.find((v) => v.isDefault) || p.variants[0];
    const linkBarcode = def?.barcode || def?.code || null;

    let status: PlanItem['status'];
    let reason: string | undefined;
    let mlItemId: string | undefined;
    let matchBy: 'sku' | 'title' | undefined;

    if (p.mlMapping?.mlItemId) {
      status = 'linked';
      mlItemId = p.mlMapping.mlItemId;
    } else {
      // ¿ya existe en ML? primero por SKU (código/barcode de alguna variante), luego por título.
      let found: string | undefined;
      let by: 'sku' | 'title' | undefined;
      for (const v of p.variants) {
        for (const key of [v.barcode, v.code]) {
          if (key && scan.bySku.has(normSku(key))) { found = scan.bySku.get(normSku(key)); by = 'sku'; break; }
        }
        if (found) break;
      }
      if (!found) {
        const nt = normTitle(p.name);
        if (nt && scan.byTitle.has(nt)) { found = scan.byTitle.get(nt); by = 'title'; }
      }
      if (found) { status = 'match'; mlItemId = found; matchBy = by; }
      else if (!hasPhoto) { status = 'skip'; reason = 'sin foto'; }
      else if (price <= 0) { status = 'skip'; reason = 'sin precio'; }
      else if (stock <= 0 && !opts.includeZeroStock) { status = 'skip'; reason = 'sin stock'; }
      else status = 'new';
    }

    items.push({
      productId: p.id, name: p.name, categoryName: p.category?.name || '',
      stock, price, hasPhoto, variantsCount: p.variants.length,
      status, reason, mlItemId, matchBy, linkBarcode,
    });
  }

  return { items, scan: { available: scan.available, scanned: scan.scanned } };
}
