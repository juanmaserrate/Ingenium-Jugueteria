import { prisma } from '../db.js';
import { requireTnClient } from './client.js';

// Normaliza un código/barcode para comparar: trim + saca ceros a la izquierda.
function z(s: unknown): string {
  const t = String(s ?? '').trim().replace(/^0+/, '');
  return t || (String(s ?? '').trim() ? '0' : '');
}

// Nombre TN puede venir como objeto { es: "..." } o string.
function tnName(n: any): string {
  if (!n) return '';
  if (typeof n === 'string') return n;
  return n.es ?? n.pt ?? Object.values(n)[0] ?? '';
}

// Vuelca el catálogo de TN (vía API, barcodes completos) como filas planas:
// una por variante. Sirve para cruzar offline contra el consolidado.
export async function dumpTnCatalog() {
  const tn = await requireTnClient();
  const rows: any[] = [];
  let page = 1; let warning: string | null = null;
  for (;;) {
    let batch: any;
    try {
      batch = await tn.listProducts({ page, per_page: 200, fields: 'id,name,variants' });
    } catch (e: any) {
      const s = e?.response?.status;
      if (s === 404) break;
      warning = `Error página ${page}: HTTP ${s ?? ''} ${e?.message ?? e}`;
      break;
    }
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const tp of batch) {
      const vs: any[] = tp.variants ?? [];
      const isVar = vs.length !== 1;
      for (const v of vs) {
        rows.push({
          tnProductId: String(tp.id),
          name: tnName(tp.name),
          isVariantProduct: isVar,
          variantCount: vs.length,
          tnVariantId: String(v.id),
          sku: v.sku ?? '',
          barcode: v.barcode ?? '',
          price: v.price ?? '',
          promotionalPrice: v.promotional_price ?? '',
          stock: v.stock ?? null,
          values: (v.values ?? []).map((x: any) => x?.es ?? x).join(' / '),
        });
      }
    }
    page++;
    if (page > 500) break;
  }
  return { count: rows.length, pages: page - 1, warning, rows };
}

export type LinkReport = {
  dryRun: boolean;
  tnProductsScanned: number;
  tnVariantProductsSkipped: number;
  linked: number;
  alreadyLinked: number;
  noMatch: number;
  conflicts: Array<{ tnId: string; name: string; barcode: string; sku: string; systemMatches: number }>;
  samples: Array<{ tnName: string; key: string; productId: string }>;
  pagesFetched: number;
  systemProducts: number;
  warning: string | null;
};

/**
 * Enlaza productos del sistema con productos de Tienda Nube por CÓDIGO DE BARRAS / SKU,
 * leyendo la API de TN (que trae el barcode completo y el tnVariantId que necesitamos).
 *
 * Reglas:
 *  - Solo productos TN SIMPLES (1 variante). Los que tienen variantes se saltan
 *    (se tratan aparte) y se cuentan en tnVariantProductsSkipped.
 *  - Match por barcode/sku contra Product.code (y Variant.barcode/code) normalizado.
 *  - Conflicto si un producto TN matchea >1 producto del sistema → no se enlaza, se reporta.
 *  - dryRun=true: solo reporta, no escribe.
 */
export async function linkByBarcode(opts: { dryRun?: boolean } = {}): Promise<LinkReport> {
  const dryRun = opts.dryRun ?? true;
  const tn = await requireTnClient();

  // 1) Precargar productos del sistema e indexar por clave normalizada.
  const products = await prisma.product.findMany({
    where: { active: true },
    include: { variants: true },
  });
  const byKey = new Map<string, Array<{ productId: string; variantId: string }>>();
  const add = (key: unknown, productId: string, variantId: string) => {
    const k = z(key);
    if (!k) return;
    const arr = byKey.get(k) ?? [];
    arr.push({ productId, variantId });
    byKey.set(k, arr);
  };
  for (const p of products) {
    const dv = p.variants.find((v) => v.isDefault) ?? p.variants[0];
    if (!dv) continue;
    add(p.code, p.id, dv.id);
    if (dv.barcode) add(dv.barcode, p.id, dv.id);
    if (dv.code) add(dv.code, p.id, dv.id);
  }

  // 2) Mapeos existentes para no duplicar.
  const existing = await prisma.variantTnMapping.findMany();
  const mappedTnVariant = new Set(existing.map((m) => m.tnVariantId));
  const mappedVariant = new Set(existing.map((m) => m.variantId));
  const mappedTnProduct = new Set((await prisma.productTnMapping.findMany()).map((m) => m.tnProductId));

  const rep: LinkReport = {
    dryRun, tnProductsScanned: 0, tnVariantProductsSkipped: 0,
    linked: 0, alreadyLinked: 0, noMatch: 0, conflicts: [], samples: [],
    pagesFetched: 0, systemProducts: products.length, warning: null,
  };

  // 3) Recorrer TN paginado. TN puede devolver 404 al pasar la última página → fin normal.
  let page = 1;
  for (;;) {
    let batch: any;
    try {
      batch = await tn.listProducts({ page, per_page: 200, fields: 'id,name,variants' });
    } catch (e: any) {
      const status = e?.response?.status;
      if (status === 404) break; // fin de páginas
      rep.warning = `Error al traer página ${page}: HTTP ${status ?? ''} ${e?.message ?? e}`;
      break;
    }
    if (!Array.isArray(batch) || batch.length === 0) break;
    rep.pagesFetched++;
    for (const tp of batch) {
      rep.tnProductsScanned++;
      const variants: any[] = tp.variants ?? [];
      if (variants.length !== 1) { rep.tnVariantProductsSkipped++; continue; }
      const v = variants[0];
      const tnVariantId = String(v.id);
      if (mappedTnVariant.has(tnVariantId) || mappedTnProduct.has(String(tp.id))) { rep.alreadyLinked++; continue; }

      const keys = [v.barcode, v.sku].filter(Boolean);
      let cands: Array<{ productId: string; variantId: string }> = [];
      for (const k of keys) {
        const m = byKey.get(z(k));
        if (m) cands = cands.concat(m);
      }
      const uniq = [...new Map(cands.map((c) => [c.variantId, c])).values()];
      if (uniq.length === 0) { rep.noMatch++; continue; }
      if (uniq.length > 1) {
        rep.conflicts.push({ tnId: String(tp.id), name: tnName(tp.name), barcode: String(v.barcode ?? ''), sku: String(v.sku ?? ''), systemMatches: uniq.length });
        continue;
      }
      const target = uniq[0];
      if (mappedVariant.has(target.variantId)) { rep.alreadyLinked++; continue; }

      if (!dryRun) {
        try {
          await prisma.$transaction(async (txn) => {
            await txn.productTnMapping.upsert({
              where: { productId: target.productId },
              update: { tnProductId: String(tp.id), lastPullAt: new Date() },
              create: { productId: target.productId, tnProductId: String(tp.id), lastPullAt: new Date() },
            });
            await txn.variantTnMapping.create({
              data: { variantId: target.variantId, tnProductId: String(tp.id), tnVariantId, lastPullAt: new Date() },
            });
          });
        } catch (e: any) {
          rep.conflicts.push({ tnId: String(tp.id), name: tnName(tp.name), barcode: String(v.barcode ?? ''), sku: String(v.sku ?? ''), systemMatches: -1 });
          continue;
        }
        mappedTnVariant.add(tnVariantId); mappedVariant.add(target.variantId); mappedTnProduct.add(String(tp.id));
      }
      rep.linked++;
      if (rep.samples.length < 25) rep.samples.push({ tnName: tnName(tp.name), key: String(v.barcode || v.sku || ''), productId: target.productId });
    }
    page++;
    if (page > 500) break; // tope de seguridad
  }
  return rep;
}
