import { prisma } from '../db.js';
import { requireTnClient } from './client.js';
import { ValidationError } from '../utils/errors.js';

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

// Normaliza un valor de variante (talle/color/modelo) para comparar:
// minúsculas, sin acentos, espacios colapsados.
function nv(s: unknown): string {
  return String(s ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim().replace(/\s+/g, ' ');
}

// Un valor de variante de TN puede ser { es: "Rojo" } o "Rojo".
function tnValueText(x: any): string {
  if (x == null) return '';
  if (typeof x === 'string') return x;
  return x.es ?? x.pt ?? Object.values(x)[0] ?? '';
}

// Etiqueta legible de una variante TN (ej: "Talle 1 / Rojo").
function tnValuesLabel(values: any): string {
  return (values ?? []).map(tnValueText).filter(Boolean).join(' / ');
}

// Clave de comparación por valor, independiente del orden de propiedades
// (ordena los tokens normalizados y los une). Sirve para casar color/modelo/talle.
function tnValuesKey(values: any): string {
  return (values ?? []).map((x: any) => nv(tnValueText(x))).filter(Boolean).sort().join('|');
}

// Misma clave pero desde la variante LOCAL (attributes { color: "rojo" }, con
// fallback al name "Rojo" o "Talle 1 / Rojo").
function localValuesKey(attributes: unknown, name: string): string {
  const attrs = attributes && typeof attributes === 'object' ? Object.values(attributes as Record<string, unknown>) : [];
  if (attrs.length) return attrs.map((v) => nv(v)).filter(Boolean).sort().join('|');
  const n = nv(name);
  if (!n || n === 'default') return '';
  return n.split('/').map((s) => nv(s)).filter(Boolean).sort().join('|');
}

// Extrae el número de talle si la etiqueta lo tiene (ej "Talle 1 (3 a 4 años)" -> "1").
// Fallback para casar talles cuando el texto completo difiere entre TN y el sistema.
function talleDigits(s: string): string {
  const m = nv(s).match(/talle\s*(\d+)/) || nv(s).match(/\bt\s*(\d+)\b/);
  return m ? m[1] : '';
}

// Vincula manualmente un producto del sistema con un producto de TN (elegido por el usuario).
// Mapea la variante "default" del producto local con la variante de TN indicada (o la 1ª).
export async function linkManual(input: { productId: string; tnProductId: string; tnVariantId?: string }) {
  const product = await prisma.product.findUnique({ where: { id: input.productId }, include: { variants: true } });
  if (!product) throw new Error('Producto no encontrado');
  const dv = product.variants.find((v) => v.isDefault) ?? product.variants[0];
  if (!dv) throw new Error('El producto no tiene variante');

  let tnVariantId = input.tnVariantId;
  if (!tnVariantId) {
    const tn = await requireTnClient();
    const tp = await tn.getProduct(input.tnProductId);
    tnVariantId = String((tp.variants ?? [])[0]?.id ?? '');
  }
  if (!tnVariantId) throw new Error('No se pudo determinar la variante de TN');

  // Evitar choque de unicidad: si ese producto/variante de TN ya está vinculado a OTRO, avisar claro.
  const existP = await prisma.productTnMapping.findUnique({ where: { tnProductId: String(input.tnProductId) } });
  if (existP && existP.productId !== product.id) throw new ValidationError('Ese producto de Tienda Nube ya está vinculado a otro producto del sistema.');
  const existV = await prisma.variantTnMapping.findUnique({ where: { tnVariantId: String(tnVariantId) } });
  if (existV && existV.variantId !== dv.id) throw new ValidationError('Esa variante de Tienda Nube ya está vinculada a otra del sistema.');

  await prisma.$transaction(async (tx) => {
    await tx.productTnMapping.upsert({
      where: { productId: product.id },
      update: { tnProductId: String(input.tnProductId), lastPullAt: new Date() },
      create: { productId: product.id, tnProductId: String(input.tnProductId), lastPullAt: new Date() },
    });
    await tx.variantTnMapping.upsert({
      where: { variantId: dv.id },
      update: { tnProductId: String(input.tnProductId), tnVariantId: String(tnVariantId), lastPullAt: new Date() },
      create: { variantId: dv.id, tnProductId: String(input.tnProductId), tnVariantId: String(tnVariantId), lastPullAt: new Date() },
    });
  });
  // Empuja el stock actual a TN para dejarlo sincronizado de entrada.
  const { enqueueSync } = await import('../sync/queue.js');
  await enqueueSync('push_stock', { variantId: dv.id });
  return { ok: true, productId: product.id, variantId: dv.id, tnProductId: input.tnProductId, tnVariantId };
}

export async function unlinkProduct(productId: string) {
  const product = await prisma.product.findUnique({ where: { id: productId }, include: { variants: true } });
  if (!product) throw new Error('Producto no encontrado');
  await prisma.variantTnMapping.deleteMany({ where: { variantId: { in: product.variants.map((v) => v.id) } } });
  await prisma.productTnMapping.deleteMany({ where: { productId } });
  return { ok: true };
}

export type LinkVariantsReport = {
  ok: boolean;
  productId: string;
  tnProductId: string;
  linked: number;
  pairs: Array<{ variantId: string; variantName: string; tnVariantId: string; tnLabel: string; by: 'barcode' | 'valor' | 'talle' }>;
  unmatchedLocal: Array<{ variantId: string; name: string }>;
  unmatchedTn: Array<{ tnVariantId: string; label: string }>;
  conflicts: string[];
};

/**
 * Vincula un producto local CON variantes a un producto de TN CON variantes,
 * mapeando cada variante de TN con la variante local que corresponde.
 *
 * Prioridad de emparejamiento por variante:
 *   1) barcode / código de barras (o SKU) exacto (normalizado)
 *   2) valor de la variante (color/modelo/talle) exacto (normalizado, sin orden)
 *   3) número de talle (para disfraces cuando el texto difiere)
 *
 * No borra nada: crea/actualiza ProductTnMapping + VariantTnMapping por par.
 * Devuelve las variantes que NO pudo casar (de ambos lados) para resolver a mano.
 */
export async function linkManualVariants(input: { productId: string; tnProductId: string }): Promise<LinkVariantsReport> {
  const product = await prisma.product.findUnique({
    where: { id: input.productId },
    include: { variants: { include: { tnMapping: true } } },
  });
  if (!product) throw new Error('Producto no encontrado');
  if (product.variants.length === 0) throw new ValidationError('El producto del sistema no tiene variantes cargadas.');

  // El producto TN no puede estar ya vinculado a OTRO producto local.
  const existP = await prisma.productTnMapping.findUnique({ where: { tnProductId: String(input.tnProductId) } });
  if (existP && existP.productId !== product.id) {
    throw new ValidationError('Ese producto de Tienda Nube ya está vinculado a otro producto del sistema.');
  }

  const tn = await requireTnClient();
  const tp = await tn.getProduct(input.tnProductId);
  const tnVariants: any[] = tp.variants ?? [];
  if (tnVariants.length === 0) throw new ValidationError('El producto de Tienda Nube no tiene variantes.');

  // Índices de variantes locales (una sola vez cada una).
  const byCode = new Map<string, (typeof product.variants)[number]>();
  const byValue = new Map<string, (typeof product.variants)[number]>();
  const byTalle = new Map<string, (typeof product.variants)[number]>();
  for (const v of product.variants) {
    if (v.barcode) byCode.set(z(v.barcode), v);
    if (v.code) byCode.set(z(v.code), v);
    const vk = localValuesKey(v.attributes, v.name);
    if (vk && !byValue.has(vk)) byValue.set(vk, v);
    const td = talleDigits(v.name) || talleDigits(JSON.stringify(v.attributes ?? {}));
    if (td && !byTalle.has(td)) byTalle.set(td, v);
  }

  const used = new Set<string>();
  const pairs: LinkVariantsReport['pairs'] = [];
  const unmatchedTn: LinkVariantsReport['unmatchedTn'] = [];
  const conflicts: string[] = [];

  for (const tv of tnVariants) {
    const tnVariantId = String(tv.id);
    const label = tnValuesLabel(tv.values);
    let match: (typeof product.variants)[number] | undefined;
    let by: 'barcode' | 'valor' | 'talle' | undefined;

    for (const k of [tv.barcode, tv.sku].filter(Boolean)) {
      const c = byCode.get(z(k));
      if (c && !used.has(c.id)) { match = c; by = 'barcode'; break; }
    }
    if (!match) {
      const c = byValue.get(tnValuesKey(tv.values));
      if (c && !used.has(c.id)) { match = c; by = 'valor'; }
    }
    if (!match) {
      const td = talleDigits(label);
      const c = td ? byTalle.get(td) : undefined;
      if (c && !used.has(c.id)) { match = c; by = 'talle'; }
    }
    if (!match) { unmatchedTn.push({ tnVariantId, label }); continue; }

    // Esa variante TN no puede estar ya vinculada a otra variante local.
    const existV = await prisma.variantTnMapping.findUnique({ where: { tnVariantId } });
    if (existV && existV.variantId !== match.id) {
      conflicts.push(`La variante de TN "${label || tnVariantId}" ya está vinculada a otra variante del sistema.`);
      continue;
    }
    used.add(match.id);
    pairs.push({ variantId: match.id, variantName: match.name, tnVariantId, tnLabel: label, by: by! });
  }

  if (pairs.length === 0) {
    throw new ValidationError('No se pudo emparejar ninguna variante (revisá los códigos o los valores de talle/color/modelo).');
  }

  await prisma.$transaction(async (tx) => {
    await tx.productTnMapping.upsert({
      where: { productId: product.id },
      update: { tnProductId: String(input.tnProductId), lastPullAt: new Date() },
      create: { productId: product.id, tnProductId: String(input.tnProductId), lastPullAt: new Date() },
    });
    for (const p of pairs) {
      await tx.variantTnMapping.upsert({
        where: { variantId: p.variantId },
        update: { tnProductId: String(input.tnProductId), tnVariantId: p.tnVariantId, lastPullAt: new Date() },
        create: { variantId: p.variantId, tnProductId: String(input.tnProductId), tnVariantId: p.tnVariantId, lastPullAt: new Date() },
      });
    }
  });

  // Dejar el stock sincronizado de entrada.
  const { enqueueSync } = await import('../sync/queue.js');
  for (const p of pairs) await enqueueSync('push_stock', { variantId: p.variantId });

  return {
    ok: true,
    productId: product.id,
    tnProductId: String(input.tnProductId),
    linked: pairs.length,
    pairs,
    unmatchedLocal: product.variants.filter((v) => !used.has(v.id)).map((v) => ({ variantId: v.id, name: v.name })),
    unmatchedTn,
    conflicts,
  };
}

/**
 * Re-enlaza un producto del sistema a OTRO producto de TN en un solo paso (para
 * arreglar vínculos equivocados) y aplica la dirección de datos elegida:
 *  - dataSource 'tn'    → el sistema toma la DESCRIPCIÓN y el PRECIO del producto de TN.
 *  - dataSource 'system'→ se publican en TN el NOMBRE, la DESCRIPCIÓN y el PRECIO del sistema.
 * Desvincula primero los mapeos actuales del producto y después vincula al nuevo
 * (producto simple → linkManual; con variantes → linkManualVariants, que empareja).
 */
export async function relinkProduct(input: {
  productId: string;
  tnProductId: string;
  tnVariantId?: string;
  dataSource: 'tn' | 'system';
}) {
  const product = await prisma.product.findUnique({
    where: { id: input.productId },
    include: { variants: true },
  });
  if (!product) throw new ValidationError('Producto no encontrado');

  // a) Desvincular los mapeos actuales de ESTE producto (si tenía otro vínculo).
  await prisma.variantTnMapping.deleteMany({ where: { variantId: { in: product.variants.map((v) => v.id) } } });
  await prisma.productTnMapping.deleteMany({ where: { productId: product.id } });

  // b) Vincular al nuevo producto de TN.
  const hasVariants = product.variants.length > 1;
  const linkResult = hasVariants
    ? await linkManualVariants({ productId: input.productId, tnProductId: input.tnProductId })
    : await linkManual({ productId: input.productId, tnProductId: input.tnProductId, tnVariantId: input.tnVariantId });
  const linked = (linkResult as { linked?: number }).linked ?? 1;

  // c) Dirección de datos.
  const { enqueueSync } = await import('../sync/queue.js');
  let pulled: { description: boolean; price: number } | null = null;
  if (input.dataSource === 'tn') {
    const tn = await requireTnClient();
    const tp = await tn.getProduct(input.tnProductId);
    const tnVariants: any[] = tp.variants ?? [];
    const desc = tp.description?.es ?? (typeof tp.description === 'string' ? tp.description : null);
    const defPrice = tnVariants[0] ? parseFloat(tnVariants[0].price) : NaN;
    const price = Number.isFinite(defPrice) ? defPrice : product.price;
    await prisma.product.update({
      where: { id: product.id },
      data: { description: desc ?? undefined, price },
    });
    // Para productos con variantes, pasar el precio de cada variante TN a su override local.
    if (hasVariants) {
      const maps = await prisma.variantTnMapping.findMany({ where: { variantId: { in: product.variants.map((v) => v.id) } } });
      for (const m of maps) {
        const tv = tnVariants.find((x) => String(x.id) === String(m.tnVariantId));
        const p = tv ? parseFloat(tv.price) : NaN;
        if (Number.isFinite(p)) await prisma.variant.update({ where: { id: m.variantId }, data: { priceOverride: p } });
      }
    }
    pulled = { description: desc != null, price };
  } else {
    // sistema → TN: nombre+descripción (push_product_update) y precio/promo (push_variant_update).
    await enqueueSync('push_product_update', { productId: product.id });
    const maps = await prisma.variantTnMapping.findMany({ where: { variantId: { in: product.variants.map((v) => v.id) } } });
    for (const m of maps) await enqueueSync('push_variant_update', { variantId: m.variantId });
  }

  return { ok: true, productId: product.id, tnProductId: String(input.tnProductId), linked, dataSource: input.dataSource, pulled };
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

/**
 * Búsqueda puntual en el catálogo de TN por término (nombre). Usa el buscador nativo
 * de Tienda Nube (?q=) y trae SOLO los que coinciden — para el picker de vinculación,
 * que antes volcaba todo el catálogo en cada apertura (lento). Devuelve 1 fila por
 * PRODUCTO (con la 1ª variante para los simples) en la forma que espera el modal.
 */
export async function searchTnCatalog(q: string) {
  const term = (q || '').trim();
  if (term.length < 2) return { rows: [] };
  const tn = await requireTnClient();
  let batch: any;
  try {
    batch = await tn.listProducts({ q: term, per_page: 50, fields: 'id,name,variants' });
  } catch (e: any) {
    if (e?.response?.status === 404) return { rows: [] };
    throw e;
  }
  const rows = (Array.isArray(batch) ? batch : []).map((tp: any) => {
    const vs: any[] = tp.variants ?? [];
    const v0 = vs[0] ?? {};
    return {
      tnProductId: String(tp.id),
      tnVariantId: String(v0.id ?? ''),
      name: tnName(tp.name),
      barcode: v0.barcode ?? '',
      sku: v0.sku ?? '',
      price: v0.price ?? '',
      isVariant: vs.length !== 1,
    };
  });
  return { rows };
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

// Chequeo de códigos desalineados: para cada producto ENLAZADO a TN, compara el código
// local (barcode/código de la variante o, si no tiene, el código del producto) contra el
// código de barras que tiene esa variante en Tienda Nube. Lista las diferencias para
// revisarlas/corregirlas. Solo lectura (baja el catálogo de TN por API). Puede tardar
// un par de minutos si el catálogo es grande.
export async function findCodeMismatches() {
  const norm = (s: unknown) => String(s ?? '').trim();
  const isDigits = (s: string) => /^[0-9]+$/.test(s);
  const stripLead = (s: string) => s.replace(/^0+/, '') || '0';
  // Saca un sufijo de variante tipo "-VERDE", "-ROSA", "-VARON" del código local.
  const baseCode = (s: string) => s.replace(/-[A-Za-z0-9]+$/, '');
  const dump = await dumpTnCatalog();
  const byVar = new Map<string, any>();
  for (const r of dump.rows) byVar.set(String(r.tnVariantId), r);

  const products = await prisma.product.findMany({
    where: { active: true, variants: { some: { tnMapping: { isNot: null } } } },
    include: { variants: { include: { tnMapping: true } } },
  });

  // Categorías: drift = código genuinamente distinto (accionable). El resto es ruido
  // conocido de la importación del catálogo a TN (Excel).
  const drift: any[] = [];
  const noVinculo: any[] = [];
  const resumen = { drift: 0, tn_corrupto: 0, solo_cero_izq: 0, tn_sin_barcode: 0, local_sin_codigo: 0, sin_vinculo_tn: 0 };
  let comparados = 0;

  for (const p of products) {
    for (const v of p.variants) {
      if (!v.tnMapping) continue;
      const tnVariantId = String(v.tnMapping.tnVariantId);
      const tn = byVar.get(tnVariantId);
      const localCodeRaw = norm(v.barcode || v.code || (v.isDefault ? p.code : ''));
      const base = { productId: p.id, name: p.name, localCode: localCodeRaw, tnProductId: v.tnMapping.tnProductId, tnVariantId };
      if (!tn) { resumen.sin_vinculo_tn++; noVinculo.push({ ...base, reason: 'la variante no existe en TN (posible mal vínculo)' }); continue; }
      comparados++;
      const tnBarcodeRaw = norm(tn.barcode);
      const tnSku = norm(tn.sku);
      // Coincidencia directa (incluye match contra el SKU de TN).
      if (localCodeRaw && (localCodeRaw === tnBarcodeRaw || localCodeRaw === tnSku)) continue;
      if (!localCodeRaw) { resumen.local_sin_codigo++; continue; }
      // Clasificar el tipo de diferencia.
      const L = stripLead(baseCode(localCodeRaw));
      if (!isDigits(tnBarcodeRaw)) { resumen.tn_corrupto++; continue; }      // sci-notation / no numérico
      const T = stripLead(tnBarcodeRaw);
      if (T === '0') { resumen.tn_sin_barcode++; continue; }                  // TN sin barcode real
      if (L === T) { resumen.solo_cero_izq++; continue; }                     // mismo número, cero a la izq/sufijo
      if (/0{5,}$/.test(tnBarcodeRaw)) { resumen.tn_corrupto++; continue; }   // redondeado (Excel)
      // Dígito de más/menos (uno es prefijo/sufijo del otro) → corrupción, no drift.
      if (L.length !== T.length && (L.startsWith(T) || T.startsWith(L) || L.endsWith(T) || T.endsWith(L))) { resumen.tn_corrupto++; continue; }
      // Genuinamente distinto → accionable.
      resumen.drift++;
      drift.push({ ...base, tnBarcode: tnBarcodeRaw, tnSku: tnSku || null, tnName: tn.name || null });
    }
  }
  drift.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  noVinculo.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  return {
    enlazados: products.length,
    comparados,
    resumen,
    nota: 'drift = código genuinamente distinto (revisar/alinear). El resto (tn_corrupto, solo_cero_izq, tn_sin_barcode) es ruido de la importación del catálogo a TN.',
    drift,
    sin_vinculo_tn: noVinculo,
  };
}

// Pisa el barcode de la variante en Tienda Nube con el código local del sistema.
// Útil cuando el código local es el correcto (p. ej. EAN-13 válido) y el de TN quedó
// corrupto por la importación del Excel. Solo toca el barcode; no modifica stock/precio/fotos.
export async function alignTnBarcode(productId: string) {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { variants: { include: { tnMapping: true } } },
  });
  if (!product) throw new ValidationError('Producto no encontrado');
  const results: Array<{ variantId: string; tnVariantId: string; from: string; to: string; ok: boolean; error?: string }> = [];
  const tn = await requireTnClient();
  for (const v of product.variants) {
    if (!v.tnMapping) continue;
    const localCode = String(v.barcode || v.code || (v.isDefault ? product.code : '') || '').trim();
    if (!localCode) continue;
    const tnProductId = String(v.tnMapping.tnProductId);
    const tnVariantId = String(v.tnMapping.tnVariantId);
    let before = '';
    try {
      try {
        const cur = await tn.getProduct(tnProductId);
        const cv = (cur?.variants || []).find((x: any) => String(x.id) === tnVariantId);
        before = String(cv?.barcode ?? '');
      } catch { /* si no se puede leer el actual, seguimos igual */ }
      if (before === localCode) {
        results.push({ variantId: v.id, tnVariantId, from: before, to: localCode, ok: true });
        continue;
      }
      await tn.updateVariant(tnProductId, tnVariantId, { barcode: localCode });
      results.push({ variantId: v.id, tnVariantId, from: before, to: localCode, ok: true });
    } catch (e: any) {
      results.push({ variantId: v.id, tnVariantId, from: before, to: localCode, ok: false, error: e?.response?.data ? JSON.stringify(e.response.data) : String(e?.message || e) });
    }
  }
  const changed = results.filter((r) => r.ok && r.from !== r.to).length;
  const failed = results.filter((r) => !r.ok).length;
  return { productId, name: product.name, changed, failed, results };
}

// Alinea MASIVAMENTE el barcode en TN al código del sistema, para todos los enlazados
// cuyo barcode en TN no coincide. Solo considera códigos locales que sean barcodes reales
// (8-14 dígitos): los que tienen código interno/placeholder (ej "SP-B") se omiten y se
// reportan para revisar a mano, así no corrompemos TN. Encola un job liviano push_barcode
// por variante (el worker los procesa con su backoff de rate-limit). dryRun = solo cuenta.
export async function enqueueAlignAllBarcodes(opts: { dryRun?: boolean } = {}) {
  const stripLead = (s: string) => s.replace(/^0+/, '') || '0';
  const isBarcode = (s: string) => /^[0-9]{8,14}$/.test(s);
  const dump = await dumpTnCatalog();
  const byVar = new Map<string, any>();
  for (const r of dump.rows) byVar.set(String(r.tnVariantId), r);

  const products = await prisma.product.findMany({
    where: { active: true, variants: { some: { tnMapping: { isNot: null } } } },
    include: { variants: { include: { tnMapping: true } } },
  });

  const candidates: string[] = [];
  const localInvalido: Array<{ productId: string; name: string; local: string }> = [];
  let enlazados = 0, yaCoincide = 0;
  for (const p of products) {
    for (const v of p.variants) {
      if (!v.tnMapping) continue;
      enlazados++;
      const local = String(v.barcode || v.code || (v.isDefault ? p.code : '') || '').trim();
      if (!isBarcode(local)) { localInvalido.push({ productId: p.id, name: p.name, local }); continue; }
      const tnBarcode = String(byVar.get(String(v.tnMapping.tnVariantId))?.barcode ?? '').trim();
      // "Coincide" = mismo número ignorando ceros a la izquierda (no vale la pena actualizar).
      if (isBarcode(tnBarcode) && stripLead(local) === stripLead(tnBarcode)) { yaCoincide++; continue; }
      candidates.push(v.id);
    }
  }

  const { enqueueSync } = await import('../sync/queue.js');
  if (!opts.dryRun) {
    for (const vid of candidates) await enqueueSync('push_barcode', { variantId: vid });
  }
  return {
    dryRun: !!opts.dryRun,
    enlazados,
    yaCoincide,
    aActualizar: candidates.length,
    localInvalido: localInvalido.length,
    localInvalidoSample: localInvalido.slice(0, 40),
    encolados: opts.dryRun ? 0 : candidates.length,
  };
}
