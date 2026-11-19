// Emparejamiento de publicaciones de Mercado Libre con variantes del inventario.
// Módulo PURO (sin base ni red) para poder testearlo: ver backend/tests/match.test.ts.
//
// Orden de confianza:
//   1) código: SKU/GTIN de la publicación (o de la variación) = barcode/código de la variante
//   2) título: título de la publicación = nombre del producto (y, si hay variaciones, el
//      valor de la variación = valor de la variante: color/talle)
// Nunca se asigna la misma variante a dos publicaciones ni se pisa un vínculo existente.

export const normSku = (s: unknown) => String(s ?? '').trim().toUpperCase().replace(/\s+/g, '');
export const normTitle = (s: unknown) =>
  String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();

export type MlListing = {
  id: string;
  title: string;
  permalink?: string | null;
  status?: string;
  categoryId?: string | null;
  qty: number;
  skus: string[];
  variations: Array<{ id: string; skus: string[]; values: string[]; qty: number }>;
};

export type InvVariant = {
  id: string;
  name?: string | null;
  barcode?: string | null;
  code?: string | null;
  attributes?: Record<string, unknown> | null;
  isDefault?: boolean;
};
export type InvProduct = { id: string; name: string; code?: string | null; variants: InvVariant[] };
export type ExistingLink = { variantId: string; mlItemId: string; mlVariationId: string | null };

export type MatchRow = {
  mlItemId: string;
  mlVariationId: string | null;
  title: string;
  variationLabel: string;
  permalink: string | null;
  mlStatus: string;
  mlCategoryId?: string | null;
  mlQty: number;
  state: 'linked' | 'match' | 'unmatched';
  by?: 'sku' | 'title';
  variantId?: string;
  productId?: string;
  productName?: string;
  variantName?: string;
  suggestedProductId?: string;
  note?: string;
};

// Valor distintivo de una variante ("Rojo", "M / Azul") o '' si es la default sin atributos.
export function variantValue(v: InvVariant): string {
  const vals = Object.values((v.attributes as Record<string, unknown>) || {})
    .map((x) => String(x ?? '').trim()).filter(Boolean);
  if (vals.length) return vals.join(' ');
  const n = String(v.name ?? '').trim();
  return n && n.toLowerCase() !== 'default' ? n : '';
}

// Marca ambigüedad: si una clave apunta a dos destinos distintos, queda en null y no se usa.
function setUnique(map: Map<string, string | null>, key: string, value: string) {
  if (!key) return;
  if (!map.has(key)) map.set(key, value);
  else if (map.get(key) !== value) map.set(key, null);
}

export function matchListings(listings: MlListing[], products: InvProduct[], existing: ExistingLink[]): MatchRow[] {
  const productById = new Map(products.map((p) => [p.id, p]));
  const variantOwner = new Map<string, { product: InvProduct; variant: InvVariant }>();
  const skuIndex = new Map<string, string | null>();      // sku → variantId
  const titleIndex = new Map<string, string | null>();    // título → productId
  const fanoutIndex = new Map<string, string | null>();   // "nombre + valor" → variantId

  for (const p of products) {
    setUnique(titleIndex, normTitle(p.name), p.id);
    setUnique(titleIndex, normTitle(p.name.slice(0, 60)), p.id);
    for (const v of p.variants) {
      variantOwner.set(v.id, { product: p, variant: v });
      if (v.barcode) setUnique(skuIndex, normSku(v.barcode), v.id);
      if (v.code) setUnique(skuIndex, normSku(v.code), v.id);
      const val = variantValue(v);
      if (val && p.variants.length > 1) {
        setUnique(fanoutIndex, normTitle(`${p.name} ${val}`), v.id);
        // mismo armado que publishProduct (fan-out): nombre(≤48) + valor, ≤60
        setUnique(fanoutIndex, normTitle(`${p.name.slice(0, 60).slice(0, 48)} ${val}`.slice(0, 60)), v.id);
      }
    }
    // El código del producto identifica a su única variante.
    if (p.code && p.variants.length === 1) setUnique(skuIndex, normSku(p.code), p.variants[0].id);
  }

  const targetKey = (itemId: string, varId: string | null) => `${itemId}|${varId ?? ''}`;
  const existingByTarget = new Map(existing.map((e) => [targetKey(e.mlItemId, e.mlVariationId), e.variantId]));
  const existingByVariant = new Map(existing.map((e) => [e.variantId, e]));
  const used = new Set<string>(); // variantes ya tomadas en esta corrida

  const describe = (variantId: string) => {
    const o = variantOwner.get(variantId);
    return o
      ? { variantId, productId: o.product.id, productName: o.product.name, variantName: variantValue(o.variant) }
      : { variantId };
  };

  const rows: MatchRow[] = [];
  for (const L of listings) {
    const itemLevelLinked = existingByTarget.get(targetKey(L.id, null));
    const titleProductId = titleIndex.get(normTitle(L.title)) ?? undefined;
    const targets: Array<MlListing['variations'][number] | null> = L.variations.length ? L.variations : [null];

    for (const t of targets) {
      const base: MatchRow = {
        mlItemId: L.id,
        mlVariationId: t ? t.id : null,
        title: L.title,
        variationLabel: t ? t.values.join(' / ') : '',
        permalink: L.permalink ?? null,
        mlStatus: L.status ?? '',
        mlCategoryId: L.categoryId ?? null,
        mlQty: t ? t.qty : L.qty,
        state: 'unmatched',
      };

      // ¿Ya está vinculada?
      const linkedVariant = existingByTarget.get(targetKey(L.id, t ? t.id : null)) ?? (t ? itemLevelLinked : undefined);
      if (linkedVariant) { rows.push({ ...base, state: 'linked', ...describe(linkedVariant) }); continue; }

      let cand: string | undefined;
      let by: 'sku' | 'title' | undefined;
      let note: string | undefined;

      // 1) por código
      for (const sku of t ? t.skus : L.skus) {
        const hit = skuIndex.get(normSku(sku));
        if (hit) { cand = hit; by = 'sku'; break; }
      }
      // una publicación sin variaciones también puede traer el SKU a nivel variación única
      // 2) por título
      if (!cand && !t) {
        const fan = fanoutIndex.get(normTitle(L.title));
        if (fan) { cand = fan; by = 'title'; }
      }
      if (!cand && titleProductId) {
        const p = productById.get(titleProductId)!;
        if (!t) {
          if (p.variants.length === 1) { cand = p.variants[0].id; by = 'title'; }
          else note = 'El producto tiene varias variantes: elegí a cuál corresponde';
        } else {
          const want = t.values.map(normTitle).filter(Boolean);
          const hits = p.variants.filter((v) => {
            const have = normTitle(variantValue(v));
            // por palabra completa (no substring: "s" no debe matchear "rosa")
            return want.length > 0 && want.every((w) => have === w || ` ${have} `.includes(` ${w} `));
          });
          if (hits.length === 1) { cand = hits[0].id; by = 'title'; }
          else note = hits.length > 1 ? 'Varias variantes coinciden: elegí cuál' : 'No encontré la variante (color/talle) en el producto';
        }
      }

      if (cand) {
        const prev = existingByVariant.get(cand);
        if (prev) {
          rows.push({ ...base, suggestedProductId: variantOwner.get(cand)?.product.id, note: `Ese producto ya está vinculado a otra publicación (${prev.mlItemId})` });
        } else if (used.has(cand)) {
          rows.push({ ...base, suggestedProductId: variantOwner.get(cand)?.product.id, note: 'Publicación duplicada: otra ya tomó ese producto' });
        } else {
          used.add(cand);
          rows.push({ ...base, state: 'match', by, ...describe(cand) });
        }
      } else {
        rows.push({ ...base, suggestedProductId: titleProductId, note });
      }
    }
  }
  return rows;
}
