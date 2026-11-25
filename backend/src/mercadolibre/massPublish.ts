import { prisma } from '../db.js';
import { buildSyncPlan } from './syncExisting.js';
import { publishProduct } from './publish.js';
import { variantValue } from './match.js';
import { isValidGtin } from './pure.js';
import { classifyForMl, publishFailureReason, isHardStop, packageFor, packageAttributes, tnDimensions, mergeDimensions, type MassProduct, type MassStatus } from './massPure.js';
import { getTnClient } from '../tiendanube/client.js';
import { requireMlClient } from './client.js';
import { resolveMlCategory, resolveMlCategoryInfo } from './publish.js';
import { newPricingCtx, targetPriceFor, type PricingCtx } from './pricing.js';

// Publicación MASIVA del stock en Mercado Libre. Dos pasos, los dos lanzados por el dueño:
//   1) analizar: clasifica todo el inventario (listo / ya vinculado / ya está en ML sin vincular
//      / sin foto / sin precio / sin stock). No toca nada en ML.
//   2) publicar: recorre los "listos" de a uno, en el servidor (no depende del navegador).
// Es idempotente (publishProduct no duplica lo ya vinculado), así que si el servidor se
// reinicia en el medio se vuelve a lanzar y sigue donde quedó.
// El trabajo vive en memoria; el último análisis y el último informe se guardan en kv_items
// para que sobrevivan a un reinicio.

const KV = { collection: 'ml_mass', analysis: 'analysis', report: 'report', schedule: 'schedule' };
const LISTING_SECONDS = 6;          // estimación por publicación (crear + descripción + condiciones + stock)
const PAUSE_MS = 300;               // respiro entre productos
const MAX_CONSECUTIVE_REJECTS = 25; // tantos rechazos seguidos = algo anda mal: se frena sola
const ANALYSIS_MAX_AGE_MS = 12 * 3600 * 1000;

type Row = { productId: string; name: string; code: string; stock?: number; detail?: string; storePrice?: number; mlPrice?: number; link?: string | null };

// 'target' = precio para que en ML quede lo mismo que en el local; 'factor' = precio del sistema
// con un recargo fijo (1 = mismo precio).
export type MassOptions = { limit: number | null; pricing: 'target' | 'factor'; priceFactor: number; minPrice: number; listingTypeId: string };

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
  belowMin?: Row[]; // no se publican sueltos: precio menor al mínimo elegido
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
  belowMin: number;    // salteados por precio menor al mínimo
  rows: Row[];         // lo publicado, con precio del sistema y precio en ML
  options?: MassOptions;
};

let job: Job | null = null;
let stopRequested = false;
let analysis: MassAnalysis | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ¿ML rechazó por el peso/medidas del paquete?
export function isPackageRejection(res: any): boolean {
  if (!res || res.ok || res.error !== 'ml_rejected') return false;
  try { return /seller_package/i.test(JSON.stringify(res.details ?? '')); } catch { return false; }
}

// Peso y medidas del paquete: los del producto; lo que falte, de su publicación de Tienda Nube.
type Dims = { weight?: number | null; height?: number | null; width?: number | null; depth?: number | null };
export async function dimensionsFor(p: Dims & { tnMapping?: { tnProductId: string } | null }) {
  const complete = [p.weight, p.height, p.width, p.depth].every((x) => Number(x) > 0);
  if (complete || !p.tnMapping?.tnProductId) return mergeDimensions(p, null);
  try {
    const tn = await getTnClient();
    if (!tn) return mergeDimensions(p, null);
    return mergeDimensions(p, tnDimensions(await tn.getProduct(p.tnMapping.tnProductId)));
  } catch { return mergeDimensions(p, null); }
}

// Publica UN producto con las reglas de la publicación masiva: precio (para ganar lo mismo que
// en el local, o con recargo fijo), paquete (el del producto → Tienda Nube → estándar) y, si se
// pide, solo en una categoría específica. Lo usan la publicación masiva y los arreglos.
export type PublishOneOpts = { listingTypeId: string; pricing: 'target' | 'factor'; priceFactor: number; minPrice?: number; requireSpecific?: boolean };
export type PricingHolder = { ctx: PricingCtx | null };
export async function pricingCtxOf(holder: PricingHolder, listingTypeId: string): Promise<PricingCtx> {
  if (!holder.ctx) {
    const integ = await prisma.integration.findUnique({ where: { provider: 'mercadolibre' } });
    if (!integ?.mlUserId) throw new Error('Mercado Libre no está conectado');
    holder.ctx = await newPricingCtx(await requireMlClient(), integ.mlUserId, listingTypeId);
  }
  return holder.ctx;
}
export async function publishOne(productId: string, o: PublishOneOpts, holder: PricingHolder): Promise<{ res: any; storePrice?: number; mlPrice?: number; belowMin?: boolean }> {
  const p = await prisma.product.findUnique({
    where: { id: productId },
    select: { name: true, price: true, weight: true, width: true, height: true, depth: true, tnMapping: { select: { tnProductId: true } }, variants: { select: { priceOverride: true } } },
  });
  if (!p) throw new Error('Producto no encontrado');
  const storePrice = p.price;
  if (o.minPrice && p.price < o.minPrice) return { res: null, storePrice, belowMin: true };
  // Nada va a una categoría "Otros": Mercado Libre lo da de baja a las horas.
  if (o.requireSpecific) {
    const info = await resolveMlCategoryInfo(productId, p.name);
    if (info?.generic) return { res: { error: 'generic_category', message: 'Mercado Libre no sugiere una categoría específica para este producto (solo "Otros"): hay que elegirla a mano' }, storePrice };
  }
  let mlPrice: number | undefined;
  // Un intento = calcular el precio para ese paquete y publicar.
  const attempt = async (dims: Dims) => {
    let priceByBase: Record<string, number> | undefined;
    if (o.pricing === 'target') {
      const ctx = await pricingCtxOf(holder, o.listingTypeId);
      const categoryId = await resolveMlCategory(productId, p.name);
      if (!categoryId) throw new Error('No se pudo determinar la categoría para calcular el precio');
      const bases = [...new Set([p.price, ...p.variants.map((v) => Number(v.priceOverride) || 0)].filter((x) => x > 0))];
      priceByBase = {};
      for (const base of bases) {
        const t = await targetPriceFor(ctx, { categoryId, storePrice: base, product: dims });
        priceByBase[String(base)] = t.price;
      }
      mlPrice = priceByBase[String(p.price)];
    } else {
      mlPrice = Math.round(p.price * o.priceFactor);
    }
    // ML exige peso y medidas del paquete en toda publicación.
    return publishProduct({ productId, listingTypeId: o.listingTypeId, priceFactor: o.priceFactor, priceByBase, attributes: packageAttributes(packageFor(dims)) });
  };
  // Paquete: lo del producto, o lo de Tienda Nube. Si ML no acepta esas medidas (pasa con
  // valores muy chicos, ej. 15 g / 4×2×2 cm), se reintenta una vez con el paquete estándar.
  const dims = await dimensionsFor(p);
  let res = await attempt(dims);
  if (isPackageRejection(res) && !packageFor(dims).assumed) res = await attempt({});
  return { res, storePrice, mlPrice };
}

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
    job: j ? { ...j, failed: undefined, partial: undefined, rows: undefined, failedCount: j.failed.length, partialCount: j.partial.length, rowsCount: (j.rows ?? []).length } : null,
    schedule: await kvGet<MassSchedule>(KV.schedule),
    analysis: a ? { at: a.at, scannedListings: a.scannedListings, counts: a.counts, failedCount: (a.failed ?? []).length, estimateSeconds: a.estimateSeconds, stale: Date.now() - new Date(a.at).getTime() > ANALYSIS_MAX_AGE_MS } : null,
  };
}

// Listados para descargar: lo que no se puede publicar y por qué.
export async function massList(list: string): Promise<Row[]> {
  if (list === 'partial' || list === 'published') {
    const j = job ?? (await kvGet<Job>(KV.report));
    return ((list === 'partial' ? j?.partial : j?.rows) ?? []) as Row[];
  }
  const a = await loadAnalysis();
  if (!a) return [];
  if (list === 'failed') return a.failed ?? [];
  if (list === 'below_min') return a.belowMin ?? [];
  if (list === 'ready') return a.ready;
  return (a.lists as any)[list] ?? [];
}

export function massStop() {
  if (job?.status === 'running') stopRequested = true;
  return { ok: true };
}

const newJob = (kind: Job['kind'], total = 0): Job => ({
  kind, status: 'running', startedAt: new Date().toISOString(), finishedAt: null, message: null,
  total, done: 0, published: 0, listings: 0, skipped: 0, failed: [], partial: [], belowMin: 0, rows: [],
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
export async function startPublish(opts: Partial<MassOptions>) {
  if (job?.status === 'running') return { started: false, reason: 'Ya hay un proceso corriendo' };
  const a = await loadAnalysis();
  if (!a) return { started: false, reason: 'Primero hay que analizar el stock' };
  if (Date.now() - new Date(a.at).getTime() > ANALYSIS_MAX_AGE_MS) return { started: false, reason: 'El análisis es viejo: volvé a analizar antes de publicar' };
  const limit = opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : null;
  const priceFactor = opts.priceFactor && opts.priceFactor > 0 ? opts.priceFactor : 1;
  const listingTypeId = opts.listingTypeId || 'gold_special';
  const pricing: MassOptions['pricing'] = opts.pricing === 'target' ? 'target' : 'factor';
  const minPrice = opts.minPrice && opts.minPrice > 0 ? Math.floor(opts.minPrice) : 0;
  const queue = limit ? a.ready.slice(0, limit) : a.ready.slice();
  if (!queue.length) return { started: false, reason: 'No hay productos listos para publicar' };

  job = { ...newJob('publish', queue.length), options: { limit, pricing, priceFactor, minPrice, listingTypeId } };
  stopRequested = false;
  const mine = job;
  void runPublish(mine, queue).catch((err) => {
    mine.status = 'error'; mine.finishedAt = new Date().toISOString();
    mine.message = `La publicación se cortó: ${err?.message ?? 'error'}`;
    void kvSet(KV.report, mine);
    void finishSchedule(`Se cortó: ${err?.message ?? 'error'}`);
  });
  return { started: true, total: queue.length };
}

async function runPublish(j: Job, queue: MassAnalysis['ready']) {
  const { priceFactor, listingTypeId, pricing, minPrice } = j.options!;
  let consecutive = 0;
  let hard = 0;
  const publishedIds = new Set<string>();
  const rejected = new Map<string, Row>(); // rechazos propios del producto (no por límite de la cuenta)
  const belowMin = new Map<string, Row>();
  const holder: PricingHolder = { ctx: null };
  await kvSet(KV.report, j);

  for (const item of queue) {
    if (stopRequested) { j.status = 'stopped'; j.message = 'Frenada a mano. Se puede volver a lanzar: sigue donde quedó.'; break; }
    let res: any;
    let storePrice: number | undefined;
    let mlPrice: number | undefined;
    try {
      const one = await publishOne(item.productId, { listingTypeId, pricing, priceFactor, minPrice, requireSpecific: true }, holder);
      storePrice = one.storePrice;
      // Los baratos no se publican sueltos: el costo fijo de ML se come la ganancia.
      if (one.belowMin) {
        belowMin.set(item.productId, { productId: item.productId, name: item.name, code: item.code, stock: item.stock, storePrice, detail: `Precio menor al mínimo ($${minPrice.toLocaleString('es-AR')})` });
        j.belowMin++; j.done++;
        continue;
      }
      res = one.res; mlPrice = one.mlPrice;
    } catch (err: any) {
      const data = err?.response?.data;
      res = { error: 'ml_rejected', details: data ?? { message: err?.message, status: err?.response?.status } };
    }

    if (res?.ok && res.alreadyLinked) {
      j.skipped++; consecutive = 0; hard = 0; publishedIds.add(item.productId);
    } else if (res?.ok) {
      j.published++; j.listings += Number(res.count) || 1; consecutive = 0; hard = 0; publishedIds.add(item.productId);
      j.rows.push({ productId: item.productId, name: item.name, code: item.code, stock: item.stock, storePrice, mlPrice, link: res.permalink ?? null });
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
  await finishSchedule(j.message ?? `Publicados ${j.published} productos (${j.listings} publicaciones), ${j.failed.length} rechazados.`);

  // Lo ya publicado sale de la lista de "listos" para que la próxima tanda no lo repita.
  if (analysis && (publishedIds.size || rejected.size || belowMin.size)) {
    analysis.ready = analysis.ready.filter((r) => !publishedIds.has(r.productId) && !rejected.has(r.productId) && !belowMin.has(r.productId));
    const prevMin = new Map((analysis.belowMin ?? []).map((r) => [r.productId, r]));
    for (const [id, row] of belowMin) prevMin.set(id, row);
    analysis.belowMin = [...prevMin.values()];
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

// ---------------------------------------------------------------------------------------
// 3) PROGRAMACIÓN: lanzar la publicación sola a una hora. Vive en kv_items, así que sobrevive
//    a un reinicio; si el servidor se reinicia EN MEDIO de la corrida, se retoma sola.
// ---------------------------------------------------------------------------------------
export type MassSchedule = {
  at: string;                 // cuándo arranca (ISO)
  options: MassOptions;
  status: 'pending' | 'running' | 'done' | 'cancelled' | 'expired' | 'error';
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  resumes?: number;
  note?: string;
};

const SCHEDULE_TICK_MS = 30_000;
const SCHEDULE_LATE_MS = 6 * 3600 * 1000;    // si el servidor estuvo caído más que esto, no arranca
const SCHEDULE_RESUME_MS = 24 * 3600 * 1000; // ventana para retomar tras un reinicio
const MAX_RESUMES = 5;
let ticking = false;

export async function setSchedule(at: Date, opts: Partial<MassOptions>) {
  if (!(at.getTime() > Date.now() - 60_000)) return { ok: false, reason: 'Esa hora ya pasó' };
  const cur = await kvGet<MassSchedule>(KV.schedule);
  if (cur?.status === 'running') return { ok: false, reason: 'Ya hay una publicación programada corriendo' };
  const s: MassSchedule = {
    at: at.toISOString(), status: 'pending', createdAt: new Date().toISOString(),
    options: {
      limit: opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : null,
      pricing: opts.pricing === 'target' ? 'target' : 'factor',
      priceFactor: opts.priceFactor && opts.priceFactor > 0 ? opts.priceFactor : 1,
      minPrice: opts.minPrice && opts.minPrice > 0 ? Math.floor(opts.minPrice) : 0,
      listingTypeId: opts.listingTypeId || 'gold_special',
    },
  };
  await kvSet(KV.schedule, s);
  return { ok: true, schedule: s };
}

export async function cancelSchedule() {
  const cur = await kvGet<MassSchedule>(KV.schedule);
  if (!cur || cur.status !== 'pending') return { ok: false, reason: 'No hay una publicación programada pendiente' };
  await kvSet(KV.schedule, { ...cur, status: 'cancelled', finishedAt: new Date().toISOString() });
  return { ok: true };
}

async function finishSchedule(note: string) {
  const cur = await kvGet<MassSchedule>(KV.schedule);
  if (cur?.status !== 'running') return;
  await kvSet(KV.schedule, { ...cur, status: 'done', finishedAt: new Date().toISOString(), note });
}

// Analiza (para tener la foto del momento) y publica con las opciones programadas.
async function runScheduled(s: MassSchedule) {
  try {
    job = newJob('analyze');
    stopRequested = false;
    await runAnalysis(job);
    const r = await startPublish(s.options);
    if (!r.started) await kvSet(KV.schedule, { ...s, status: 'error', finishedAt: new Date().toISOString(), note: r.reason });
  } catch (err: any) {
    if (job?.status === 'running') { job.status = 'error'; job.finishedAt = new Date().toISOString(); job.message = `No se pudo analizar: ${err?.message ?? 'error'}`; }
    await kvSet(KV.schedule, { ...s, status: 'error', finishedAt: new Date().toISOString(), note: String(err?.message ?? 'error') });
  }
}

async function scheduleTick() {
  if (ticking) return;
  ticking = true;
  try {
    const s = await kvGet<MassSchedule>(KV.schedule);
    if (!s) return;
    const late = Date.now() - new Date(s.at).getTime();
    if (s.status === 'pending' && late >= 0) {
      if (late > SCHEDULE_LATE_MS) { await kvSet(KV.schedule, { ...s, status: 'expired', note: 'El servidor no estaba disponible a esa hora' }); return; }
      if (job?.status === 'running') return; // espera a que termine lo que esté corriendo
      const run: MassSchedule = { ...s, status: 'running', startedAt: new Date().toISOString() };
      await kvSet(KV.schedule, run);
      await runScheduled(run);
    } else if (s.status === 'running' && !job) {
      // El servidor se reinició con la corrida en marcha: se retoma (no duplica lo ya publicado).
      if ((s.resumes ?? 0) >= MAX_RESUMES || late > SCHEDULE_RESUME_MS) {
        await kvSet(KV.schedule, { ...s, status: 'error', finishedAt: new Date().toISOString(), note: 'Se interrumpió por reinicios del servidor' });
        return;
      }
      const run: MassSchedule = { ...s, resumes: (s.resumes ?? 0) + 1 };
      await kvSet(KV.schedule, run);
      await runScheduled(run);
    }
  } catch { /* se reintenta en el próximo tick */ } finally { ticking = false; }
}

export function startMassScheduler() {
  setInterval(() => { void scheduleTick(); }, SCHEDULE_TICK_MS).unref?.();
}

// Vista previa: a qué precio saldrían algunos productos con el precio objetivo. No publica.
export async function pricePreview(n = 10, minPrice = 0) {
  const integ = await prisma.integration.findUnique({ where: { provider: 'mercadolibre' } });
  if (!integ?.mlUserId) throw new Error('Mercado Libre no está conectado');
  const ctx = await newPricingCtx(await requireMlClient(), integ.mlUserId, 'gold_special');
  const products = await prisma.product.findMany({
    where: { active: true, price: { gte: Math.max(1, minPrice) }, mlMapping: null, variants: { some: { stocks: { some: { qty: { gt: 0 } } } } } },
    select: { id: true, code: true, name: true, price: true, cost: true, weight: true, width: true, height: true, depth: true, tnMapping: { select: { tnProductId: true } } },
    orderBy: { price: 'asc' },
  });
  const step = Math.max(1, Math.floor(products.length / Math.max(1, n)));
  const sample = products.filter((_, i) => i % step === 0).slice(0, n);
  const rows: any[] = [];
  for (const p of sample) {
    try {
      const categoryId = await resolveMlCategory(p.id, p.name);
      if (!categoryId) { rows.push({ code: p.code, name: p.name, storePrice: p.price, error: 'sin categoría' }); continue; }
      const dims = await dimensionsFor(p);
      const pkg = packageFor(dims);
      const t = await targetPriceFor(ctx, { categoryId, storePrice: p.price, product: dims });
      rows.push({ productId: p.id, code: p.code, name: p.name, cost: p.cost, storePrice: p.price, categoryId, package: packageAttributes(pkg), packageAssumed: pkg.assumed, inTn: !!p.tnMapping, mlPrice: t.price, net: t.net, freeShipping: t.freeShipping, capped: t.capped, upPct: Math.round((t.price / p.price - 1) * 1000) / 10 });
    } catch (err: any) {
      rows.push({ code: p.code, name: p.name, storePrice: p.price, error: String(err?.response?.data?.message ?? err?.message ?? 'error').slice(0, 160) });
    }
  }
  return { candidates: products.length, threshold: ctx.threshold, rows };
}
