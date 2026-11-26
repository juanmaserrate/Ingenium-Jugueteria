import { prisma } from '../db.js';
import { requireMlClient } from './client.js';
import { summarizeCatalog, catalogStateOf, type CatalogRow } from './catalogPure.js';
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
  kind: 'scan' | 'optin';
  status: 'running' | 'done' | 'stopped' | 'error';
  startedAt: string; finishedAt: string | null; message: string | null;
  total: number; done: number; ok: number; failed: number;
  rows: CatalogRow[];
  summary: ReturnType<typeof summarizeCatalog> | null;
  results: Array<{ itemId: string; name: string; result: 'ok' | 'failed'; detail: string; catalogItemId?: string | null }>;
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

export async function catalogStatus(withRows = false) {
  const j = await load();
  if (!j) return null;
  return withRows ? j : { ...j, rows: undefined, results: j.results.slice(-200) };
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
export async function startCatalogOptin(input: { limit?: number | null; itemIds?: string[] }) {
  if (job?.status === 'running') return { started: false, reason: 'Ya hay un proceso de catálogo corriendo' };
  const prev = await load();
  if (!prev?.rows?.length) return { started: false, reason: 'Primero hay que relevar el catálogo' };
  let targets = prev.rows.filter((r) => r.state === 'ready' && r.catalogProductId);
  if (input.itemIds?.length) { const only = new Set(input.itemIds); targets = targets.filter((r) => only.has(r.itemId)); }
  if (input.limit && input.limit > 0) targets = targets.slice(0, Math.floor(input.limit));
  if (!targets.length) return { started: false, reason: 'No hay publicaciones listas para sumar a catálogo' };

  job = { ...fresh('optin', prev.rows), total: targets.length };
  stopRequested = false;
  const mine = job;
  void runOptin(mine, targets).catch(async (err) => {
    mine.status = 'error'; mine.finishedAt = new Date().toISOString(); mine.message = String(err?.message ?? 'error');
    await save(mine);
  });
  return { started: true, total: targets.length };
}

async function runOptin(j: CatalogJob, targets: CatalogRow[]) {
  const ml = await requireMlClient();
  let consecutive = 0;
  let hard = 0;
  for (const r of targets) {
    if (stopRequested) { j.status = 'stopped'; j.message = 'Frenado a mano. Se puede volver a lanzar: lo ya sumado no se repite.'; break; }
    try {
      const created: any = await ml.catalogOptin(r.itemId, r.catalogProductId!);
      const newId = created?.id ? String(created.id) : null;
      r.state = 'in_catalog';
      if (newId) r.twinIds = [...r.twinIds, newId];
      j.results.push({ itemId: r.itemId, name: r.name, result: 'ok', detail: `En catálogo${created?.status ? ' (' + created.status + ')' : ''}`, catalogItemId: newId });
      j.ok++; consecutive = 0; hard = 0;
    } catch (err: any) {
      const status = Number(err?.response?.status);
      if ([401, 403, 429].includes(status)) hard++; else hard = 0;
      consecutive++;
      r.eligibilityReason = mlErrorText(err).slice(0, 200);
      r.state = 'optin_failed';
      j.results.push({ itemId: r.itemId, name: r.name, result: 'failed', detail: r.eligibilityReason });
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
