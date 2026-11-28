import { prisma } from '../db.js';
import { requireMlClient } from './client.js';
import { summarizeCatalog, catalogStateOf, pickCatalogProduct, pickCategoryForDomain, fillFromCatalogProduct, categoryByDomain, type CatalogRow } from './catalogPure.js';
import { auditRows } from './audit.js';
import { missingForCategory } from './repairPure.js';
import { isGenericCategory } from './massPure.js';
import { pricingCtxOf, dimensionsFor, type PricingHolder } from './massPublish.js';
import { targetPriceFor } from './pricing.js';
import { isValidGtin } from './pure.js';
import { mlErrorText } from './repairPure.js';

// CATÁLOGO de Mercado Libre. Una publicación "de catálogo" compite en la ficha del producto
// (donde el comprador elige vendedor) y comparte stock y condiciones con la publicación propia
// con la que queda sincronizada. Las ventas de los primeros días entraron casi todas por ahí.
//   scan  → cuenta cuáles de las publicaciones vinculadas ya están en catálogo, cuáles puede
//           sumar Mercado Libre ("listas para sumar") y cuáles no. Solo lee.
//   optin → suma a catálogo las que están listas (crea la publicación de catálogo sincronizada).

const KV = { collection: 'ml_mass', key: 'catalog' };
const PAUSE_MS = 250;
const MAX_CONSECUTIVE_FAILS = 15;

type CatalogJob = {
  kind: 'scan' | 'optin' | 'match' | 'move';
  status: 'running' | 'done' | 'stopped' | 'error';
  startedAt: string; finishedAt: string | null; message: string | null;
  total: number; done: number; ok: number; failed: number; skipped?: number; dryRun?: boolean;
  rows: CatalogRow[];
  summary: ReturnType<typeof summarizeCatalog> | null;
  results: Array<{ itemId: string; name: string; result: 'ok' | 'failed' | 'skipped' | 'preview'; detail: string; catalogItemId?: string | null; from?: string; to?: string }>;
};

let job: CatalogJob | null = null;
let stopRequested = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function save(j: CatalogJob) {
  await prisma.kvItem.upsert({
    where: { collection_key: { collection: KV.collection, key: KV.key } },
    update: { value: j as any }, create: { collection: KV.collection, key: KV.key, value: j as any },
  }).catch(() => {});
}
async function load(): Promise<CatalogJob | null> {
  if (job) return job;
  const row = await prisma.kvItem.findUnique({ where: { collection_key: { collection: KV.collection, key: KV.key } } }).catch(() => null);
  const v = (row?.value as CatalogJob) ?? null;
  return v && v.status === 'running' ? { ...v, status: 'error', message: 'Se interrumpió (el servidor se reinició). Se puede volver a lanzar.' } : v;
}

export async function catalogStatus(withRows = false, allResults = false) {
  const j = await load();
  if (!j) return null;
  return withRows ? j : { ...j, rows: undefined, results: allResults ? j.results : j.results.slice(-200) };
}
export async function catalogRows(state?: string): Promise<CatalogRow[]> {
  const j = await load();
  const rows = j?.rows ?? [];
  return state ? rows.filter((r) => r.state === state) : rows;
}
export function catalogStop() {
  if (job?.status === 'running') stopRequested = true;
  return { ok: true };
}

const fresh = (kind: CatalogJob['kind'], rows: CatalogRow[] = []): CatalogJob => ({
  kind, status: 'running', startedAt: new Date().toISOString(), finishedAt: null, message: null,
  total: 0, done: 0, ok: 0, failed: 0, rows, summary: rows.length ? summarizeCatalog(rows) : null, results: [],
});

// --- 1) Relevamiento (solo lee) ---
export function startCatalogScan() {
  if (job?.status === 'running') return { started: false, reason: 'Ya hay un proceso de catálogo corriendo' };
  job = fresh('scan');
  stopRequested = false;
  const mine = job;
  void runScan(mine).catch(async (err) => {
    mine.status = 'error'; mine.finishedAt = new Date().toISOString(); mine.message = String(err?.message ?? 'error');
    await save(mine);
  });
  return { started: true };
}

async function runScan(j: CatalogJob) {
  const ml = await requireMlClient();
  const maps = await prisma.variantMeliMapping.findMany({
    select: { mlItemId: true, variant: { select: { product: { select: { id: true, name: true, code: true } } } } },
  });
  const byItem = new Map<string, { productId: string; name: string; code: string }>();
  for (const m of maps) if (!byItem.has(m.mlItemId)) byItem.set(m.mlItemId, { productId: m.variant.product.id, name: m.variant.product.name, code: m.variant.product.code });
  const ids = [...byItem.keys()];
  j.total = ids.length;

  // De a 20 (multiget), con lo justo para saber cómo está cada una.
  for (let i = 0; i < ids.length; i += 20) {
    if (stopRequested) { j.status = 'stopped'; j.message = 'Frenado a mano.'; break; }
    const chunk = ids.slice(i, i + 20);
    let res: any[] = [];
    try { res = await ml.getItemsMulti(chunk, 'id,status,sub_status,catalog_product_id,catalog_listing,tags,item_relations,price,available_quantity,domain_id'); }
    catch { res = []; }
    const got = new Map<string, any>();
    for (const r of Array.isArray(res) ? res : []) if (r?.code === 200 && r.body?.id) got.set(String(r.body.id), r.body);
    for (const id of chunk) {
      const p = byItem.get(id)!;
      let it = got.get(id);
      // Si la consulta en tanda falló o no la trajo, se la lee sola (no dejarla como "error").
      if (!it) { try { it = await ml.getItem(id); } catch { it = undefined; } }
      const row: CatalogRow = {
        itemId: id, productId: p.productId, name: p.name, code: p.code,
        status: String(it?.status ?? 'error'),
        catalogProductId: it?.catalog_product_id ? String(it.catalog_product_id) : null,
        isCatalogListing: !!it?.catalog_listing,
        twinIds: (Array.isArray(it?.item_relations) ? it.item_relations : []).map((r: any) => String(r?.id ?? '')).filter(Boolean),
        eligibleTag: Array.isArray(it?.tags) && it.tags.includes('catalog_listing_eligible'),
        domainId: it?.domain_id ?? null,
        price: Number(it?.price) || 0, qty: Number(it?.available_quantity) || 0,
        eligibility: null, eligibilityReason: null, state: 'unknown',
      };
      j.rows.push(row);
    }
    j.done = Math.min(ids.length, i + 20);
    await sleep(120);
  }

  // A las que ML marca como elegibles (o ya tienen producto de catálogo) y todavía no tienen
  // su publicación de catálogo, se les pregunta el estado exacto.
  const ask = j.rows.filter((r) => r.status === 'active' && !r.isCatalogListing && !r.twinIds.length && (r.eligibleTag || r.catalogProductId));
  for (const r of ask) {
    if (stopRequested) break;
    try {
      const e: any = await ml.catalogEligibility(r.itemId);
      r.eligibility = e?.status ? String(e.status) : null;
      r.eligibilityReason = e?.reason ? String(e.reason) : null;
      if (!r.catalogProductId && e?.catalog_product_id) r.catalogProductId = String(e.catalog_product_id);
    } catch (err: any) {
      r.eligibility = 'ERROR'; r.eligibilityReason = mlErrorText(err).slice(0, 160);
    }
    await sleep(120);
  }
  for (const r of j.rows) r.state = catalogStateOf(r);
  j.summary = summarizeCatalog(j.rows);
  if (j.status === 'running') j.status = 'done';
  j.finishedAt = new Date().toISOString();
  await save(j);
}

// --- 2) Sumar a catálogo las que están listas ---
export async function startCatalogOptin(input: { limit?: number | null; itemIds?: string[]; matched?: boolean; pairs?: Record<string, string> }) {
  if (job?.status === 'running') return { started: false, reason: 'Ya hay un proceso de catálogo corriendo' };
  const prev = await load();
  if (!prev?.rows?.length) return { started: false, reason: 'Primero hay que relevar el catálogo' };
  // matched = las que no tenían ficha y se les encontró una por código de barras.
  // pairs = ficha elegida a mano para publicaciones sin ficha (publicación → producto de catálogo).
  const forced = new Set<string>();
  let targets: CatalogRow[];
  if (input.pairs && Object.keys(input.pairs).length) {
    targets = prev.rows.filter((r) => r.state === 'no_product' && r.status === 'active' && input.pairs![r.itemId]);
    for (const r of targets) { r.matchProductId = input.pairs[r.itemId]; r.state = 'matched'; forced.add(r.itemId); }
  } else {
    targets = input.matched
      ? prev.rows.filter((r) => r.state === 'matched' && r.matchProductId)
      : prev.rows.filter((r) => r.state === 'ready' && r.catalogProductId);
  }
  if (input.itemIds?.length) { const only = new Set(input.itemIds); targets = targets.filter((r) => only.has(r.itemId)); }
  if (input.limit && input.limit > 0) targets = targets.slice(0, Math.floor(input.limit));
  if (!targets.length) return { started: false, reason: 'No hay publicaciones listas para sumar a catálogo' };

  job = { ...fresh('optin', prev.rows), total: targets.length };
  stopRequested = false;
  const mine = job;
  void runOptin(mine, targets, forced).catch(async (err) => {
    mine.status = 'error'; mine.finishedAt = new Date().toISOString(); mine.message = String(err?.message ?? 'error');
    await save(mine);
  });
  return { started: true, total: targets.length };
}

async function runOptin(j: CatalogJob, targets: CatalogRow[], forced = new Set<string>()) {
  const ml = await requireMlClient();
  let consecutive = 0;
  let hard = 0;
  for (const r of targets) {
    if (stopRequested) { j.status = 'stopped'; j.message = 'Frenado a mano. Se puede volver a lanzar: lo ya sumado no se repite.'; break; }
    try {
      const created: any = await ml.catalogOptin(r.itemId, (r.state === 'matched' ? r.matchProductId : r.catalogProductId)!);
      const newId = created?.id ? String(created.id) : null;
      r.state = 'in_catalog';
      if (newId) r.twinIds = [...r.twinIds, newId];
      j.results.push({ itemId: r.itemId, name: r.name, result: 'ok', detail: `En catálogo${created?.status ? ' (' + created.status + ')' : ''}`, catalogItemId: newId });
      j.ok++; consecutive = 0; hard = 0;
    } catch (err: any) {
      const status = Number(err?.response?.status);
      if ([401, 403, 429].includes(status)) hard++; else hard = 0;
      consecutive++;
      const why = mlErrorText(err).slice(0, 200);
      // Las de ficha elegida a mano vuelven a 'sin ficha' con el motivo, no quedan como rechazadas.
      if (forced.has(r.itemId)) { r.state = 'no_product'; r.matchNote = `Mercado Libre no aceptó la ficha ${r.matchProductId}: ${why}`.slice(0, 200); r.matchProductId = null; }
      else { r.eligibilityReason = why; r.state = 'optin_failed'; }
      j.results.push({ itemId: r.itemId, name: r.name, result: 'failed', detail: why });
      j.failed++;
    }
    j.done++;
    if (hard >= 3) { j.status = 'stopped'; j.message = 'Mercado Libre está rechazando por límite o permisos de la cuenta. Se frenó solo.'; break; }
    if (consecutive >= MAX_CONSECUTIVE_FAILS) { j.status = 'stopped'; j.message = `Se frenó solo: ${MAX_CONSECUTIVE_FAILS} fallos seguidos. Revisá el detalle antes de seguir.`; break; }
    if (j.done % 25 === 0) { j.summary = summarizeCatalog(j.rows); await save(j); }
    await sleep(PAUSE_MS);
  }
  j.summary = summarizeCatalog(j.rows);
  if (j.status === 'running') j.status = 'done';
  j.finishedAt = new Date().toISOString();
  await save(j);
}

// --- 3) Buscar ficha de catálogo por código de barras para las que ML no asoció ---
export async function startCatalogMatch(input: { limit?: number | null } = {}) {
  if (job?.status === 'running') return { started: false, reason: 'Ya hay un proceso de catálogo corriendo' };
  const prev = await load();
  if (!prev?.rows?.length) return { started: false, reason: 'Primero hay que relevar el catálogo' };
  let targets = prev.rows.filter((r) => r.state === 'no_product' && r.status === 'active');
  if (input.limit && input.limit > 0) targets = targets.slice(0, Math.floor(input.limit));
  if (!targets.length) return { started: false, reason: 'No hay publicaciones sin ficha para buscar' };
  job = { ...fresh('match', prev.rows), total: targets.length };
  stopRequested = false;
  const mine = job;
  void runMatch(mine, targets).catch(async (err) => {
    mine.status = 'error'; mine.finishedAt = new Date().toISOString(); mine.message = String(err?.message ?? 'error');
    await save(mine);
  });
  return { started: true, total: targets.length };
}

async function runMatch(j: CatalogJob, targets: CatalogRow[]) {
  const ml = await requireMlClient();
  // Código de barras real de cada publicación, tomado del sistema.
  const maps = await prisma.variantMeliMapping.findMany({
    where: { mlItemId: { in: targets.map((r) => r.itemId) } },
    select: { mlItemId: true, variant: { select: { barcode: true, code: true, product: { select: { code: true, _count: { select: { variants: true } } } } } } },
  });
  const gtinOf = new Map<string, string>();
  for (const m of maps) {
    const v = m.variant;
    const g = [v.barcode, v.code, v.product._count.variants === 1 ? v.product.code : null].map((x) => String(x ?? '').trim()).find((x) => isValidGtin(x));
    if (g && !gtinOf.has(m.mlItemId)) gtinOf.set(m.mlItemId, g);
  }
  for (const r of targets) {
    if (stopRequested) { j.status = 'stopped'; j.message = 'Frenado a mano.'; break; }
    const gtin = gtinOf.get(r.itemId) ?? null;
    r.gtin = gtin;
    if (!gtin) { r.matchNote = 'el producto no tiene código de barras real'; j.done++; continue; }
    try {
      const res: any = await ml.productSearch({ status: 'active', site_id: 'MLA', product_identifier: gtin });
      const pick = pickCatalogProduct(res?.results, r.domainId);
      r.matchNote = pick.note;
      if (pick.product) {
        r.matchProductId = pick.product.id; r.matchName = pick.product.name.slice(0, 120); r.matchDomain = pick.product.domainId;
        r.state = 'matched'; j.ok++;
      }
    } catch (err: any) {
      r.matchNote = `no se pudo consultar: ${mlErrorText(err).slice(0, 100)}`; j.failed++;
    }
    j.done++;
    if (j.done % 50 === 0) { j.summary = summarizeCatalog(j.rows); await save(j); }
    await sleep(150);
  }
  j.summary = summarizeCatalog(j.rows);
  if (j.status === 'running') j.status = 'done';
  j.finishedAt = new Date().toISOString();
  await save(j);
}

// --- 4) Pasar una publicación al rubro de su ficha de catálogo ---
// Mercado Libre solo deja sumar a catálogo si la publicación está en el MISMO rubro (domain)
// que la ficha ("does not belong to domain"). Para las que tienen la ficha en otro rubro: se
// cambia la categoría de la publicación a una de ese rubro (completando los datos obligatorios
// que se puedan), se ajusta el precio a la comisión nueva y queda 'matched' para sumarla después
// con optin {matched:true}. pairs = publicación → ficha, elegidas a mano. dryRun no toca nada.
export async function startCatalogMove(input: { pairs: Record<string, string>; dryRun?: boolean; limit?: number | null }) {
  if (job?.status === 'running') return { started: false, reason: 'Ya hay un proceso de catálogo corriendo' };
  const prev = await load();
  if (!prev?.rows?.length) return { started: false, reason: 'Primero hay que relevar el catálogo' };
  let targets = prev.rows.filter((r) => r.state === 'no_product' && r.status === 'active' && input.pairs[r.itemId]);
  if (input.limit && input.limit > 0) targets = targets.slice(0, Math.floor(input.limit));
  if (!targets.length) return { started: false, reason: 'Ninguna de esas publicaciones está sin ficha y activa' };
  job = { ...fresh('move', prev.rows), total: targets.length, skipped: 0, dryRun: !!input.dryRun };
  stopRequested = false;
  const mine = job;
  void runMove(mine, targets, input.pairs, !!input.dryRun).catch(async (err) => {
    mine.status = 'error'; mine.finishedAt = new Date().toISOString(); mine.message = String(err?.message ?? 'error');
    await save(mine);
  });
  return { started: true, total: targets.length, dryRun: !!input.dryRun };
}

async function runMove(j: CatalogJob, targets: CatalogRow[], pairs: Record<string, string>, dryRun: boolean) {
  const ml = await requireMlClient();
  const holder: PricingHolder = { ctx: null };
  const paths = new Map<string, string>();
  const schemas = new Map<string, any[]>();
  const domainCat = new Map<string, string>(); // rubro → última categoría usada de ese rubro
  const catPath = async (id: string) => {
    if (!paths.has(id)) {
      try { const c: any = await ml.getCategory(id); paths.set(id, (Array.isArray(c?.path_from_root) ? c.path_from_root.map((x: any) => x.name).join(' > ') : c?.name) || id); }
      catch { paths.set(id, id); }
    }
    return paths.get(id)!;
  };
  const catAttrs = async (id: string) => {
    if (!schemas.has(id)) { try { schemas.set(id, (await ml.getCategoryAttributes(id)) || []); } catch { schemas.set(id, []); } }
    return schemas.get(id)!;
  };
  // Categoría del rubro de la ficha: la que ML sugiere para el nombre de la ficha (o el nuestro).
  // Respaldo: la categoría que ya usan nuestras publicaciones activas de cada rubro
  // (rubro del relevamiento de catálogo + categoría de la última auditoría).
  const catOfItem = new Map((await auditRows().catch(() => [])).filter((a) => a.status === 'active' && a.categoryId).map((a) => [a.itemId, a.categoryId]));
  const ownByDomain = categoryByDomain(j.rows.filter((x) => x.state === 'in_catalog' || x.status === 'active').map((x) => ({ domainId: x.domainId, categoryId: catOfItem.get(x.itemId) ?? null })));
  const categoryFor = async (domainId: string, names: string[]) => {
    for (const q of names) {
      const name = String(q || '').slice(0, 60).trim();
      if (!name) continue;
      let preds: any[] = [];
      try { const res = await ml.predictCategory('MLA', name, 8); preds = Array.isArray(res) ? res : []; } catch { preds = []; }
      const cands = [];
      for (const p of preds) {
        const id = String(p?.category_id ?? '');
        if (!id) continue;
        cands.push({ categoryId: id, domainId: p?.domain_id ? String(p.domain_id) : null, generic: isGenericCategory(await catPath(id)) });
      }
      const hit = pickCategoryForDomain(cands, domainId);
      if (hit) { domainCat.set(domainId, hit); return hit; }
    }
    return domainCat.get(domainId) ?? ownByDomain.get(domainId) ?? null;
  };

  let consecutive = 0;
  let hard = 0;
  const push = (r: CatalogRow, result: 'ok' | 'failed' | 'skipped' | 'preview', detail: string, from?: string, to?: string) => {
    j.results.push({ itemId: r.itemId, name: r.name, result, detail, from, to });
    if (result === 'failed') { j.failed++; consecutive++; } else { consecutive = 0; hard = 0; if (result === 'skipped') j.skipped = (j.skipped || 0) + 1; else j.ok++; }
  };
  for (const r of targets) {
    if (stopRequested) { j.status = 'stopped'; j.message = 'Frenado a mano. Se puede volver a lanzar: lo ya movido no se repite.'; break; }
    const pid = pairs[r.itemId];
    try {
      const prod: any = await ml.catalogProduct(pid);
      const domainId = prod?.domain_id ? String(prod.domain_id) : null;
      if (!domainId || (prod?.status && prod.status !== 'active')) { push(r, 'skipped', 'La ficha no está activa'); }
      else {
        const it: any = await ml.getItem(r.itemId);
        const from = await catPath(String(it?.category_id ?? ''));
        if (it?.status !== 'active') push(r, 'skipped', `Estado ${it?.status}: no se toca`, from);
        else if ((Array.isArray(it.item_relations) && it.item_relations.length) || it.catalog_listing) { r.state = 'in_catalog'; push(r, 'skipped', 'Ya está en catálogo', from); }
        else if (Array.isArray(it.variations) && it.variations.length) push(r, 'skipped', 'Tiene variaciones: no se mueve sola', from);
        else {
          const sameDomain = String(it.domain_id ?? '') === domainId;
          const catId = sameDomain ? String(it.category_id) : await categoryFor(domainId, [String(prod?.name ?? ''), r.name]);
          if (!catId) push(r, 'skipped', `No encontré una categoría del rubro ${domainId}`, from);
          else {
            const to = await catPath(catId);
            const product = await prisma.product.findUnique({
              where: { id: r.productId },
              select: { name: true, price: true, weight: true, width: true, height: true, depth: true, brand: { select: { name: true } }, tnMapping: { select: { tnProductId: true } } },
            });
            const title = String(it.family_name || it.title || r.name).slice(0, 60);
            const need = sameDomain ? { fill: [], blocking: [] } : missingForCategory(await catAttrs(catId), it.attributes, { title, brand: product?.brand?.name ?? null });
            // Lo que falte y sea de lista (ej. "Es un kit de fábrica", "Colección") se toma de la propia ficha.
            if (need.blocking.length) {
              const extra = fillFromCatalogProduct(await catAttrs(catId), need.blocking, prod?.attributes);
              need.fill.push(...extra.fill);
              need.blocking = extra.still;
            }
            // Los datos de texto libre se completaban con el título; si la ficha trae el dato real
            // (modelo, colección, personaje, título del libro…) se usa ese. Autor y editorial NO se
            // inventan: si la ficha no los trae, la publicación no se mueve.
            if (!sameDomain && need.fill.length) {
              const fromFicha = new Map<string, string>();
              for (const a of (Array.isArray(prod?.attributes) ? prod.attributes : [])) if (a?.id && a.value_name != null && String(a.value_name).trim() !== '') fromFicha.set(String(a.id), String(a.value_name));
              need.fill = need.fill.map((a) => (fromFicha.has(a.id) ? { id: a.id, value_name: fromFicha.get(a.id)! } : a));
              const fake = need.fill.filter((a) => (a.id === 'AUTHOR' || a.id === 'BOOK_PUBLISHER') && !fromFicha.has(a.id));
              if (fake.length) {
                need.fill = need.fill.filter((a) => !fake.includes(a));
                need.blocking = [...need.blocking, ...fake.map((a) => (a.id === 'AUTHOR' ? 'Autor' : 'Editorial'))];
              }
            }
            if (need.blocking.length) push(r, 'skipped', `La categoría nueva pide datos que no tenemos: ${need.blocking.join(', ')}`, from, to);
            else if (dryRun) push(r, 'preview', sameDomain ? 'Ya está en el rubro de la ficha' : (need.fill.length ? `Se completaría: ${need.fill.map((a) => a.id).join(', ')}` : 'Cambio directo'), from, to);
            else {
              let note = 'Ya estaba en el rubro de la ficha';
              if (!sameDomain) {
                await ml.updateItem(r.itemId, { category_id: catId, ...(need.fill.length ? { attributes: need.fill } : {}) });
                note = 'Categoría cambiada';
                // Precio: mismo criterio que al publicar, con la comisión de la categoría nueva.
                try {
                  const vm = await prisma.variantMeliMapping.findFirst({ where: { mlItemId: r.itemId }, select: { variant: { select: { priceOverride: true } } } });
                  const storePrice = Number(vm?.variant?.priceOverride ?? product?.price) || 0;
                  if (product && storePrice > 0) {
                    const pctx = await pricingCtxOf(holder, String(it.listing_type_id || 'gold_special'));
                    const t = await targetPriceFor(pctx, { categoryId: catId, storePrice, product: await dimensionsFor(product) });
                    const cur = Number(it.price) || 0;
                    const diff = Math.abs(t.price - cur);
                    if (cur > 0 && diff >= 10) {
                      if (diff / cur <= 0.1) { await ml.updateItem(r.itemId, { price: t.price }); note += ` · precio ${cur} → ${t.price}`; }
                      else note += ` · precio sin tocar (${cur}; con la comisión nueva sería ${t.price})`;
                    }
                  }
                } catch (err: any) { note += ` · precio sin ajustar (${mlErrorText(err).slice(0, 100)})`; }
              }
              r.domainId = domainId; r.matchProductId = pid; r.matchName = String(prod?.name ?? '').slice(0, 120); r.matchDomain = domainId;
              r.matchNote = 'movida al rubro de la ficha'; r.state = 'matched';
              push(r, 'ok', note, from, to);
            }
          }
        }
      }
    } catch (err: any) {
      const status = Number(err?.response?.status);
      if ([401, 403, 429].includes(status)) hard++;
      push(r, 'failed', mlErrorText(err).slice(0, 200));
    }
    j.done++;
    if (hard >= 3) { j.status = 'stopped'; j.message = 'Mercado Libre está rechazando por límite o permisos de la cuenta. Se frenó solo.'; break; }
    if (consecutive >= MAX_CONSECUTIVE_FAILS) { j.status = 'stopped'; j.message = `Se frenó solo: ${MAX_CONSECUTIVE_FAILS} fallos seguidos. Revisá el detalle antes de seguir.`; break; }
    if (j.done % 25 === 0) { j.summary = summarizeCatalog(j.rows); if (!dryRun) await save(j); }
    await sleep(PAUSE_MS);
  }
  j.summary = summarizeCatalog(j.rows);
  if (j.status === 'running') j.status = 'done';
  j.finishedAt = new Date().toISOString();
  await save(j);
}
