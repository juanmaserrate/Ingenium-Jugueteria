// Lógica PURA de Mercado Libre (sin base ni red), testeable: ver backend/tests/ml-terms.test.ts.

export const WARRANTY_DAYS = 30;
export const STORE_SALE_TERMS = [
  { id: 'WARRANTY_TYPE', value_name: 'Garantía del vendedor' },
  { id: 'WARRANTY_TIME', value_name: `${WARRANTY_DAYS} días` },
];

type Term = { id: string; value_id?: string | null; value_name?: string | null };

// PURA (testeable): mezcla los sale_terms actuales con la garantía de la tienda sin perder
// los demás (p. ej. disponibilidad de stock). Devuelve null si ya estaba igual.
export function mergeWarrantyTerms(current: Term[] | null | undefined): Term[] | null {
  const cur = Array.isArray(current) ? current : [];
  const type = cur.find((t) => t.id === 'WARRANTY_TYPE');
  const time = cur.find((t) => t.id === 'WARRANTY_TIME');
  const norm = (s: unknown) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  const already = norm(type?.value_name) === 'garantia del vendedor' && norm(time?.value_name) === `${WARRANTY_DAYS} dias`;
  if (already) return null;
  const others = cur
    .filter((t) => t.id !== 'WARRANTY_TYPE' && t.id !== 'WARRANTY_TIME')
    .map((t) => (t.value_id ? { id: t.id, value_id: t.value_id } : { id: t.id, value_name: t.value_name ?? '' }));
  return [...others, ...STORE_SALE_TERMS];
}

// PURA (testeable): elige la categoría más votada entre las predicciones de varios títulos.
// `share` = proporción de títulos que cayeron en la ganadora (qué tan homogénea es la categoría).
export function tallyPredictions(preds: Array<{ categoryId: string; categoryName?: string | null } | null | undefined>) {
  const votes = new Map<string, { categoryId: string; categoryName: string; votes: number }>();
  let total = 0;
  for (const p of preds) {
    if (!p?.categoryId) continue;
    total++;
    const cur = votes.get(p.categoryId) ?? { categoryId: p.categoryId, categoryName: p.categoryName || p.categoryId, votes: 0 };
    cur.votes++;
    votes.set(p.categoryId, cur);
  }
  const candidates = [...votes.values()].sort((a, b) => b.votes - a.votes)
    .map((c) => ({ ...c, share: total ? c.votes / total : 0 }));
  return { total, candidates };
}

// PURA: toma `n` elementos repartidos de forma pareja a lo largo de la lista (no los primeros).
export function pickSpread<T>(list: T[], n: number): T[] {
  if (n <= 0) return [];
  if (list.length <= n) return [...list];
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(list[Math.floor((i * list.length) / n)]);
  return out;
}


// PURA: a partir de pares (categoría del sistema, categoría de ML de una publicación real)
// arma, por cada categoría del sistema, las categorías de ML que usa el vendedor y su peso.
export function tallyListingCategories(pairs: Array<{ systemCategoryId: string | null | undefined; mlCategoryId: string | null | undefined }>) {
  const by = new Map<string, Map<string, number>>();
  for (const p of pairs) {
    if (!p.systemCategoryId || !p.mlCategoryId) continue;
    const m = by.get(p.systemCategoryId) ?? new Map<string, number>();
    m.set(p.mlCategoryId, (m.get(p.mlCategoryId) ?? 0) + 1);
    by.set(p.systemCategoryId, m);
  }
  const out = new Map<string, { total: number; candidates: Array<{ categoryId: string; votes: number; share: number }> }>();
  for (const [sys, m] of by) {
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    const candidates = [...m.entries()].map(([categoryId, votes]) => ({ categoryId, votes, share: votes / total }))
      .sort((a, b) => b.votes - a.votes);
    out.set(sys, { total, candidates });
  }
  return out;
}
