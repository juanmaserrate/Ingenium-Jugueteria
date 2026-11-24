import { prisma } from '../db.js';
import { buildSyncPlan } from './syncExisting.js';
import { publishProduct } from './publish.js';
import { variantValue } from './match.js';
import { isValidGtin } from './pure.js';
import { classifyForMl, publishFailureReason, isHardStop, type MassProduct, type MassStatus } from './massPure.js';

// Publicación MASIVA del stock en Mercado Libre. Dos pasos, los dos lanzados por el dueño:
//   1) analizar: clasifica todo el inventario (listo / ya vinculado / ya está en ML sin vincular
//      / sin foto / sin precio / sin stock). No toca nada en ML.
//   2) publicar: recorre los "listos" de a uno, en el servidor (no depende del navegador).
// Es idempotente (publishProduct no duplica lo ya vinculado), así que si el servidor se
// reinicia en el medio se vuelve a lanzar y sigue donde quedó.
// El trabajo vive en memoria; el último análisis y el último informe se guardan en kv_items
// para que sobrevivan a un reinicio.

const KV = { collection: 'ml_mass', analysis: 'analysis', report: 'report' };
const LISTING_SECONDS = 6;          // estimación por publicación (crear + descripción + condiciones + stock)
const PAUSE_MS = 300;               // respiro entre productos
const MAX_CONSECUTIVE_REJECTS = 25; // tantos rechazos seguidos = algo anda mal: se frena sola
const ANALYSIS_MAX_AGE_MS = 12 * 3600 * 1000;

type Row = { productId: string; name: string; code: string; stock?: number; detail?: string };

export type MassAnalysis = {
  at: string;
  scannedListings: number;
  counts: Record<MassStatus, number> & { total: number; listings: number; noGtin: number };
  estimateSeconds: number;
  ready: Array<Row & { listings: number }>;
  lists: { on_ml: Row[]; no_picture: Row[]; no_price: Row[] };
  // Los que Mercado Libre rechazó desde este análisis (acumulado entre tandas). Salen de
  // "listos" para no reintentarlos en cada tanda; al volver a analizar se prueban de nuevo.
  failed: Row[];
};

type Job = {
  kind: 'analyze' | 'publish';
  status: 'running' | 'done' | 'stopped' | 'error' | 'interrupted';
  startedAt: string;
  finishedAt: string | null;
  message: string | null;
  total: number;
  done: number;
  published: number;   // productos publicados
  listings: number;    // publicaciones creadas (un producto con variantes crea varias)
  skipped: number;     // ya estaban vinculados
  failed: Row[];
  partial: Row[];      // se publicó pero alguna variante quedó afuera
  options?: { limit: number | null; priceFactor: number; listingTypeId: string };
};

let job: Job | null = null;
let stopRequested = false;
let analysis: MassAnalysis | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function kvGet<T>(key: string): Promise<T | null> {
  const row = await prisma.kvItem.findUnique({ where: { collection_key: { collection: KV.collection, key } } }).catch(() => null);
  return (row?.value as T) ?? null;
}
async function kvSet(key: string, value: unknown) {
  await prisma.kvItem.upsert({
    where: { collection_key: { collection: KV.collection, key } },
    update: { value: value as any }, create: { collection: KV.collection, key, value: value as any },
  }).catch(() => {});
}

async function loadAnalysis(): Promise<MassAnalysis | null> {
  if (!analysis) analysis = await kvGet<MassAnalysis>(KV.analysis);
  return analysis;
}

// Estado para la pantalla. Si el servidor se reinició con un trabajo corriendo, el informe
// guardado quedó en "running": se muestra como interrumpido.
export async function massStatus() {
  const a = await loadAnalysis();
  let j: Job | null = job;
  if (!j) {
    const saved = await kvGet<Job>(KV.report);
    if (saved) j = saved.status === 'running' ? { ...saved, status: 'interrupted', message: 'El servidor se reinició. Volvé a lanzar la publicación: sigue donde quedó.' } : saved;
  }
  return {
    job: j ? { ...j, failed: undefined, partial: undefined, failedCount: j.failed.length, partialCount: j.partial.length } : null,
    analysis: a ? { at: a.at, scannedListings: a.scannedListings, counts: a.counts, failedCount: (a.failed ?? []).length, estimateSeconds: a.estimateSeconds, stale: Date.now() - new Date(a.at).getTime() > ANALYSIS_MAX_AGE_MS } : null,
  };
}

// Listados para descargar: lo que no se puede publicar y por qué.
export async function massList(list: string): Promise<Row[]> {
  if (list === 'partial') {
    const j = job ?? (await kvGet<Job>(KV.report));
    return (j?.partial ?? []) as Row[];
  }
  const a = await loadAnalysis();
  if (!a) return [];
  if (list === 'failed') return a.failed ?? [];
  if (list === 'ready') return a.ready;
  return (a.lists as any)[list] ?? [];
}

export function massStop() {
  if (job?.status === 'running') stopRequested = true;
  return { ok: true };
}

const newJob = (kind: Job['kind'], total = 0): Job => ({
  kind, status: 'running', startedAt: new Date().toISOString(), finishedAt: null, message: null,
  total, done: 0, published: 0, listings: 0, skipped: 0, failed: [], partial: [],
});

// ---------------------------------------------------------------------------------------
// 1) ANÁLISIS
// ---------------------------------------------------------------------------------------
export function startAnalysis() {
  if (job?.status === 'running') return { started: false, reason: 'Ya hay un proceso corriendo' };
  job = newJob('analyze');
  stopRequested = false;
  const mine = job;
  void runAnalysis(mine).catch((err) => {
    mine.status = 'error'; mine.finishedAt = new Date().toISOString();
    mine.message = `No se pudo analizar: ${err?.message ?? 'error'}`;
  });
  return { started: true };
}

async function runAnalysis(j: Job) {
  // Publicaciones que ya existen en ML (activas y pausadas) y a qué producto corresponden.
  j.message = 'Leyendo tus publicaciones de Mercado Libre...';
  const plan = await buildSyncPlan();
  if (!plan.available) throw new Error('Mercado Libre no está conectado');
  const onMlProducts = new Set<string>();
  const onMlVariants = new Set<string>();
  for (const r of plan.rows) {
    if (r.state === 'linked') continue;
    if (r.variantId) onMlVariants.add(r.variantId);
    if (r.state === 'match' && r.productId && !r.variantId) onMlProducts.add(r.productId);
    // Coincidencia dudosa (duplicada o ambigua): igual se la saca de la publicación masiva.
    if (r.suggestedProductId) onMlProducts.add(r.suggestedProductId);
  }

  j.message = 'Revisando el inventario...';
  const products = await prisma.product.findMany({
    where: { active: true },
    select: {
      id: true, name: true, code: true, price: true,
      _count: { select: { images: true } },
      tnMapping: { select: { id: true } },
      mlMapping: { select: { id: true } },
      variants: {
        select: {
          id: true, name: true, attributes: true, barcode: true, code: true, isDefault: true, priceOverride: true,
          mlMapping: { select: { id: true } },
          stocks: { select: { qty: true, reservedQty: true } },
        },
      },
    },
  });

  const counts: MassAnalysis['counts'] = { total: products.length, ready: 0, linked: 0, no_stock: 0, on_ml: 0, no_price: 0, no_picture: 0, listings: 0, noGtin: 0 };
  const ready: MassAnalysis['ready'] = [];
  const lists: MassAnalysis['lists'] = { on_ml: [], no_picture: [], no_price: [] };

  for (const p of products) {
    const single = p.variants.length === 1;
    const mp: MassProduct = {
      id: p.id, name: p.name, code: p.code,
      hasPicture: p._count.images > 0 || !!p.tnMapping,
      productLinked: !!p.mlMapping,
      variants: p.variants.map((v) => ({
        id: v.id,
        value: variantValue(v as any),
        stock: v.stocks.reduce((s, st) => s + Math.max(0, st.qty - st.reservedQty), 0),
        linked: !!v.mlMapping,
        price: Number(v.priceOverride ?? p.price) || 0,
        hasGtin: [v.barcode, v.code, single ? p.code : null].some((c) => isValidGtin(String(c ?? '').trim())),
        isDefault: v.isDefault,
      })),
    };
    const verdict = classifyForMl(mp, { product: onMlProducts.has(p.id), variantIds: onMlVariants });
    counts[verdict.status]++;
    const row: Row = { productId: p.id, name: p.name, code: p.code };
    if (verdict.status === 'ready') {
      counts.listings += verdict.listings;
      if (verdict.noGtin) counts.noGtin++;
      ready.push({ ...row, stock: verdict.stock, listings: verdict.listings });
    } else if (verdict.status === 'on_ml' || verdict.status === 'no_picture' || verdict.status === 'no_price') {
      const stock = mp.variants.reduce((s, v) => s + v.stock, 0);
      lists[verdict.status].push({ ...row, stock });
    }
  }
  // Primero lo que más stock tiene.
  ready.sort((a, b) => (b.stock ?? 0) - (a.stock ?? 0) || a.name.localeCompare(b.name, 'es'));

  analysis = {
    at: new Date().toISOString(), scannedListings: plan.scanned, counts,
    estimateSeconds: counts.listings * LISTING_SECONDS, ready, lists, failed: [],
  };
  await kvSet(KV.analysis, analysis);
  j.status = 'done'; j.finishedAt = new Date().toISOString(); j.message = null;
  j.total = products.length; j.done = products.length;
}

// ---------------------------------------------------------------------------------------
// 2) PUBLICACIÓN
// ---------------------------------------------------------------------------------------
export async function startPublish(opts: { limit?: number | null; priceFactor?: number; listingTypeId?: string }) {
  if (job?.status === 'running') return { started: false, reason: 'Ya hay un proceso corriendo' };
  const a = await loadAnalysis();
  if (!a) return { started: false, reason: 'Primero hay que analizar el stock' };
  if (Date.now() - new Date(a.at).getTime() > ANALYSIS_MAX_AGE_MS) return { started: false, reason: 'El análisis es viejo: volvé a analizar antes de publicar' };
  const limit = opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : null;
  const priceFactor = opts.priceFactor && opts.priceFactor > 0 ? opts.priceFactor : 1;
  const listingTypeId = opts.listingTypeId || 'gold_special';
  const queue = limit ? a.ready.slice(0, limit) : a.ready.slice();
  if (!queue.length) return { started: false, reason: 'No hay productos listos para publicar' };

  job = { ...newJob('publish', queue.length), options: { limit, priceFactor, listingTypeId } };
  stopRequested = false;
  const mine = job;
  void runPublish(mine, queue).catch((err) => {
    mine.status = 'error'; mine.finishedAt = new Date().toISOString();
    mine.message = `La publicación se cortó: ${err?.message ?? 'error'}`;
    void kvSet(KV.report, mine);
  });
  return { started: true, total: queue.length };
}

async function runPublish(j: Job, queue: MassAnalysis['ready']) {
  const { priceFactor, listingTypeId } = j.options!;
  let consecutive = 0;
  let hard = 0;
  const publishedIds = new Set<string>();
  const rejected = new Map<string, Row>(); // rechazos propios del producto (no por límite de la cuenta)
  await kvSet(KV.report, j);

  for (const item of queue) {
    if (stopRequested) { j.status = 'stopped'; j.message = 'Frenada a mano. Se puede volver a lanzar: sigue donde quedó.'; break; }
    let res: any;
    try {
      res = await publishProduct({ productId: item.productId, listingTypeId, priceFactor });
    } catch (err: any) {
      const data = err?.response?.data;
      res = { error: 'ml_rejected', details: data ?? { message: err?.message, status: err?.response?.status } };
    }

    if (res?.ok && res.alreadyLinked) {
      j.skipped++; consecutive = 0; hard = 0; publishedIds.add(item.productId);
    } else if (res?.ok) {
      j.published++; j.listings += Number(res.count) || 1; consecutive = 0; hard = 0; publishedIds.add(item.productId);
      const left = [
        ...(Array.isArray(res.failed) ? res.failed.map((f: any) => `${f.value}: ${publishFailureReason({ error: 'ml_rejected', details: f.error })}`) : []),
      ];
      if (left.length) j.partial.push({ productId: item.productId, name: item.name, code: item.code, detail: left.join(' · ').slice(0, 600) });
    } else {
      const row: Row = { productId: item.productId, name: item.name, code: item.code, stock: item.stock, detail: publishFailureReason(res) };
      j.failed.push(row);
      const transient = res?.error === 'ml_rejected' && isHardStop(res);
      if (!transient) rejected.set(item.productId, row);
      if (res?.error === 'ml_rejected') {
        consecutive++;
        if (transient) hard++; else hard = 0;
      }
      // Límite o bloqueo de la cuenta en ML: tres seguidos y se frena sin insistir.
      if (hard >= 3) { j.status = 'stopped'; j.message = 'Mercado Libre está rechazando por límite o permisos de la cuenta. Se frenó sola; probá de nuevo más tarde.'; j.done++; break; }
      if (consecutive >= MAX_CONSECUTIVE_REJECTS) { j.status = 'stopped'; j.message = `Se frenó sola: ${MAX_CONSECUTIVE_REJECTS} rechazos seguidos de Mercado Libre. Revisá el listado de fallidos antes de seguir.`; j.done++; break; }
    }
    j.done++;
    if (j.done % 25 === 0) await kvSet(KV.report, j);
    await sleep(PAUSE_MS);
  }

  if (j.status === 'running') j.status = 'done';
  j.finishedAt = new Date().toISOString();
  await kvSet(KV.report, j);

  // Lo ya publicado sale de la lista de "listos" para que la próxima tanda no lo repita.
  if (analysis && (publishedIds.size || rejected.size)) {
    analysis.ready = analysis.ready.filter((r) => !publishedIds.has(r.productId) && !rejected.has(r.productId));
    analysis.counts.ready = analysis.ready.length;
    analysis.counts.linked += publishedIds.size;
    const prev = new Map((analysis.failed ?? []).map((r) => [r.productId, r]));
    for (const [id, row] of rejected) prev.set(id, row);
    analysis.failed = [...prev.values()];
    analysis.counts.listings = analysis.ready.reduce((s, r) => s + r.listings, 0);
    analysis.estimateSeconds = analysis.counts.listings * LISTING_SECONDS;
    await kvSet(KV.analysis, analysis);
  }
}
