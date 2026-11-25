// Lógica pura del relevamiento de catálogo de Mercado Libre (sin red ni base).

export type CatalogState =
  | 'in_catalog'    // ya compite: tiene su publicación de catálogo sincronizada (o es una)
  | 'ready'         // Mercado Libre dice que se puede sumar ya
  | 'not_eligible'  // tiene producto de catálogo o marca de elegible, pero ML no la deja sumar
  | 'no_product'    // Mercado Libre no la asoció a ningún producto de su catálogo
  | 'inactive'      // pausada, en revisión o dada de baja: no se evalúa
  | 'optin_failed'  // se intentó sumar y Mercado Libre la rechazó
  | 'unknown';

export type CatalogRow = {
  itemId: string; productId: string; name: string; code: string;
  status: string;
  catalogProductId: string | null;
  isCatalogListing: boolean;
  twinIds: string[];            // publicaciones con las que está sincronizada (item_relations)
  eligibleTag: boolean;         // tag catalog_listing_eligible
  domainId: string | null;
  price: number; qty: number;
  eligibility: string | null;   // status que devuelve /catalog_listing_eligibility
  eligibilityReason: string | null;
  state: CatalogState;
};

type Input = Pick<CatalogRow, 'status' | 'isCatalogListing' | 'twinIds' | 'eligibleTag' | 'catalogProductId' | 'eligibility'>;

export function catalogStateOf(r: Input): CatalogState {
  if (r.isCatalogListing || r.twinIds.length > 0) return 'in_catalog';
  const e = String(r.eligibility ?? '').toUpperCase();
  if (e === 'ALREADY_OPTED_IN' || e === 'COMPETING') return 'in_catalog';
  if (r.status !== 'active') return 'inactive';
  if (e === 'READY_FOR_OPTIN') return 'ready';
  if (e) return 'not_eligible';
  if (!r.catalogProductId && !r.eligibleTag) return 'no_product';
  return 'not_eligible';
}

export function summarizeCatalog(rows: CatalogRow[]) {
  const counts: Record<CatalogState, number> = { in_catalog: 0, ready: 0, not_eligible: 0, no_product: 0, inactive: 0, optin_failed: 0, unknown: 0 };
  for (const r of rows) counts[r.state] = (counts[r.state] || 0) + 1;
  const tally = (list: CatalogRow[], keyOf: (r: CatalogRow) => string) => {
    const m: Record<string, number> = {};
    for (const r of list) { const k = keyOf(r); m[k] = (m[k] || 0) + 1; }
    return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([key, n]) => ({ key, n }));
  };
  const blocked = rows.filter((r) => r.state === 'not_eligible' || r.state === 'optin_failed');
  return {
    total: rows.length,
    counts,
    // Por qué no se pueden sumar las que ML conoce pero no deja.
    blockedReasons: tally(blocked, (r) => `${r.eligibility ?? 'sin estado'}${r.eligibilityReason ? ': ' + r.eligibilityReason : ''}`.slice(0, 120)),
    // En qué rubros de ML están las que ya compiten y las listas para sumar.
    inCatalogByDomain: tally(rows.filter((r) => r.state === 'in_catalog'), (r) => r.domainId ?? 'sin rubro'),
    readyByDomain: tally(rows.filter((r) => r.state === 'ready'), (r) => r.domainId ?? 'sin rubro'),
  };
}
