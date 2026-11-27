import { prisma } from '../db.js';
import { requireMlClient, type MlClient } from './client.js';
import { auditRows, auditStatus } from './audit.js';
import { resolveMlCategoryInfo } from './publish.js';
import { pickSpecificCategory } from './categoryPick.js';
import { massStatus, publishOne, pricingCtxOf, dimensionsFor, type PricingHolder } from './massPublish.js';
import { targetPriceFor } from './pricing.js';
import { isGenericCategory, isHardStop, publishFailureReason, type AuditRow } from './massPure.js';
import { missingForCategory, mlErrorText, repairTargets, planPictures, UPSCALE_TO, type RepairAction } from './repairPure.js';

// ARREGLOS sobre las publicaciones que dejó la publicación masiva, a partir de la última
// auditoría. Tres acciones, todas lanzadas por el dueño y con modo de prueba (dryRun):
//   reactivate   → las que quedaron pausadas esperando las fotos: se vuelven a activar.
//   recategorize → las vivas en una categoría "Otros": se pasan a la que predice ML.
//   republish    → las que ML dio de baja: se desvinculan y se publican de nuevo, bien categorizadas.
// Antes de tocar cada publicación se la vuelve a leer en vivo: si ya cambió, no se la toca.

const KV = { collection: 'ml_mass', key: 'repair' };
const PAUSE_MS = 250;
const MAX_CONSECUTIVE_FAILS = 15;
const LISTING = 'gold_special';

export type RepairRow = {
  itemId: string; productId: string; name: string;
  result: 'ok' | 'skipped' | 'failed' | 'preview';
  detail: string; from?: string; to?: string; newItemId?: string; link?: string | null;
};
type RepairJob = {
  action: RepairAction; dryRun: boolean;
  status: 'running' | 'done' | 'stopped' | 'error';
  startedAt: string; finishedAt: string | null; message: string | null;
  total: number; done: number; ok: number; skipped: number; failed: number;
  rows: RepairRow[];
};

let job: RepairJob | null = null;
let stopRequested = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function save(j: RepairJob) {
  await prisma.kvItem.upsert({
    where: { collection_key: { collection: KV.collection, key: KV.key } },
    update: { value: j as any }, create: { collection: KV.collection, key: KV.key, value: j as any },
  }).catch(() => {});
}

export async function repairStatus(withRows = false) {
  let j: RepairJob | null = job;
  if (!j) {
    const row = await prisma.kvItem.findUnique({ where: { collection_key: { collection: KV.collection, key: KV.key } } }).catch(() => null);
    const v = (row?.value as RepairJob) ?? null;
    j = v && v.status === 'running' ? { ...v, status: 'error', message: 'Se interrumpió (el servidor se reinició). Se puede volver a lanzar.' } : v;
  }
  if (!j) return null;
  return withRows ? j : { ...j, rows: undefined };
}

export function repairStop() {
  if (job?.status === 'running') stopRequested = true;
  return { ok: true };
}

// categoryByProduct: categoría de ML elegida a mano para cada producto ({ productId: 'MLA…' }).
// Si viene, solo se tocan esos productos y se usa esa categoría (no se predice nada).
export async function startRepair(input: { action: RepairAction; dryRun?: boolean; limit?: number | null; itemIds?: string[]; categoryByProduct?: Record<string, string>; titleByProduct?: Record<string, string>; attrsByProduct?: Record<string, Array<{ id: string; value_name: string }>> }) {
  if (job?.status === 'running') return { started: false, reason: 'Ya hay un arreglo corriendo' };
  const mass = await massStatus();
  if (mass.job?.status === 'running') return { started: false, reason: 'Hay una publicación masiva corriendo' };
  const a = await auditStatus();
  if (!a || a.status !== 'done') return { started: false, reason: 'Primero hay que correr la auditoría' };

  let targets = repairTargets(await auditRows(), input.action);
  if (input.itemIds?.length) { const only = new Set(input.itemIds); targets = targets.filter((r) => only.has(r.itemId)); }
  const overrides = input.categoryByProduct && Object.keys(input.categoryByProduct).length ? input.categoryByProduct : null;
  if (overrides && input.action !== 'reactivate') targets = targets.filter((r) => !!overrides[r.productId]);
  if (input.limit && input.limit > 0) targets = targets.slice(0, Math.floor(input.limit));
  if (!targets.length) return { started: false, reason: 'No hay publicaciones para esa acción en la última auditoría' };

  job = {
    action: input.action, dryRun: !!input.dryRun, status: 'running', startedAt: new Date().toISOString(), finishedAt: null,
    message: null, total: targets.length, done: 0, ok: 0, skipped: 0, failed: 0, rows: [],
  };
  stopRequested = false;
  const mine = job;
  const extras = { titles: input.titleByProduct ?? {}, attrs: input.attrsByProduct ?? {} };
  void run(mine, targets, overrides, extras).catch(async (err) => {
    mine.status = 'error'; mine.finishedAt = new Date().toISOString(); mine.message = String(err?.message ?? 'error');
    await save(mine);
  });
  return { started: true, total: targets.length };
}

type Ctx = {
  ml: MlClient;
  holder: PricingHolder;
  overrides: Record<string, string> | null;
  titles: Record<string, string>;
  attrs: Record<string, Array<{ id: string; value_name: string }>>;
  catPath: (id: string) => Promise<string>;
  catAttrs: (id: string) => Promise<any[]>;
};

async function run(j: RepairJob, targets: AuditRow[], overrides: Record<string, string> | null, extras: { titles: Record<string, string>; attrs: Record<string, Array<{ id: string; value_name: string }>> } = { titles: {}, attrs: {} }) {
  const ml = await requireMlClient();
  const paths = new Map<string, string>();
  const schemas = new Map<string, any[]>();
  const ctx: Ctx = {
    ml, holder: { ctx: null }, overrides, titles: extras.titles, attrs: extras.attrs,
    catPath: async (id) => {
      if (!paths.has(id)) {
        try { const c: any = await ml.getCategory(id); paths.set(id, (Array.isArray(c?.path_from_root) ? c.path_from_root.map((x: any) => x.name).join(' > ') : c?.name) || id); }
        catch { paths.set(id, id); }
      }
      return paths.get(id)!;
    },
    catAttrs: async (id) => {
      if (!schemas.has(id)) { try { schemas.set(id, (await ml.getCategoryAttributes(id)) || []); } catch { schemas.set(id, []); } }
      return schemas.get(id)!;
    },
  };

  // Republicar va POR PRODUCTO: uno con variantes puede tener varias publicaciones dadas de baja.
  const units: AuditRow[][] = [];
  if (j.action === 'republish') {
    const byProduct = new Map<string, AuditRow[]>();
    for (const r of targets) { const l = byProduct.get(r.productId) ?? []; l.push(r); byProduct.set(r.productId, l); }
    units.push(...byProduct.values());
    j.total = units.length;
  } else {
    for (const r of targets) units.push([r]);
  }

  let consecutive = 0;
  let hard = 0;
  for (const unit of units) {
    if (stopRequested) { j.status = 'stopped'; j.message = 'Frenado a mano. Se puede volver a lanzar: lo ya arreglado no se repite.'; break; }
    const first = unit[0];
    let row: RepairRow;
    try {
      row = j.action === 'reactivate' ? await reactivate(ctx, first, j.dryRun)
        : j.action === 'recategorize' ? await recategorize(ctx, first, j.dryRun)
          : await republish(ctx, unit, j.dryRun);
    } catch (err: any) {
      const status = Number(err?.response?.status);
      if ([401, 403, 429].includes(status)) hard++;
      row = { itemId: first.itemId, productId: first.productId, name: first.name, result: 'failed', detail: mlErrorText(err) };
    }
    j.rows.push(row);
    if (row.result === 'failed') { j.failed++; consecutive++; }
    else { consecutive = 0; hard = 0; if (row.result === 'skipped') j.skipped++; else j.ok++; }
    j.done++;
    if (hard >= 3) { j.status = 'stopped'; j.message = 'Mercado Libre está rechazando por límite o permisos de la cuenta. Se frenó solo.'; break; }
    if (consecutive >= MAX_CONSECUTIVE_FAILS) { j.status = 'stopped'; j.message = `Se frenó solo: ${MAX_CONSECUTIVE_FAILS} fallos seguidos. Revisá el detalle antes de seguir.`; break; }
    if (j.done % 25 === 0) await save(j);
    await sleep(PAUSE_MS);
  }
  if (j.status === 'running') j.status = 'done';
  j.finishedAt = new Date().toISOString();
  await save(j);
}

const base = (r: AuditRow) => ({ itemId: r.itemId, productId: r.productId, name: r.name });

// Baja una foto, la agranda hasta UPSCALE_TO px de lado más largo y la sube a ML. Devuelve su id.
async function upscaleAndUpload(ml: MlClient, url: string): Promise<string> {
  const sharp = (await import('sharp')).default;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`No se pudo bajar la foto (${res.status})`);
  const out = await sharp(Buffer.from(await res.arrayBuffer()))
    .resize({ width: UPSCALE_TO, height: UPSCALE_TO, fit: 'inside', kernel: 'lanczos3' })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 92 })
    .toBuffer();
  const up: any = await ml.uploadPicture(out, 'foto.jpg', 'image/jpeg');
  if (!up?.id) throw new Error('Mercado Libre no devolvió la foto subida');
  return String(up.id);
}

// 1) Pausada esperando las fotos → corregir las fotos chicas (ML no acepta las de menos de
//    500 px) y activar.
async function reactivate(ctx: Ctx, r: AuditRow, dryRun: boolean): Promise<RepairRow> {
  const it: any = await ctx.ml.getItem(r.itemId);
  const subOf = (x: any): string[] => (Array.isArray(x?.sub_status) ? x.sub_status.map(String) : []);
  const sub = subOf(it);
  if (it?.status === 'active') return { ...base(r), result: 'skipped', detail: 'Ya estaba activa' };
  if (it?.status !== 'paused') return { ...base(r), result: 'skipped', detail: `Estado ${it?.status}${sub.length ? ' (' + sub.join(' ') + ')' : ''}: no se toca` };
  if (!sub.includes('picture_download_pending')) return { ...base(r), result: 'skipped', detail: 'Está pausada por otro motivo: no se toca' };

  const urls = new Map<string, string>((it.pictures || []).map((p: any) => [String(p.id), String(p.secure_url || p.url || '')]));
  const plan = planPictures((it.pictures || []).map((p: any) => ({ id: String(p.id), size: p.max_size || p.size })));
  const sizes = plan.map((p) => `${p.w}x${p.h}`).join(', ');
  const up = plan.filter((p) => p.action === 'upscale').length;
  const drop = plan.filter((p) => p.action === 'drop').length;
  if (plan.length && drop === plan.length) return { ...base(r), result: 'skipped', detail: `Foto demasiado chica (${sizes}): hay que cargar una más grande en Tienda Nube`, link: it?.permalink ?? null };
  const what = `${up ? `${up} foto${up > 1 ? 's' : ''} agrandada${up > 1 ? 's' : ''}` : ''}${up && drop ? ', ' : ''}${drop ? `${drop} quitada${drop > 1 ? 's' : ''} por muy chica${drop > 1 ? 's' : ''}` : ''}` || 'fotos sin cambios';
  if (dryRun) return { ...base(r), result: 'preview', detail: `Fotos ${sizes}: ${what}`, link: it?.permalink ?? null };

  if (up || drop) {
    const pictures: Array<{ id: string }> = [];
    for (const p of plan) {
      if (p.action === 'keep') pictures.push({ id: p.id });
      else if (p.action === 'upscale') pictures.push({ id: await upscaleAndUpload(ctx.ml, urls.get(p.id) || '') });
    }
    await ctx.ml.updateItem(r.itemId, { pictures });
  }
  // ML procesa las fotos y la reactiva; si queda pausada sin motivo, se la activa.
  let after: any = null;
  for (let i = 0; i < 4; i++) {
    await sleep(2500);
    after = await ctx.ml.getItem(r.itemId);
    if (after?.status === 'active') break;
    if (after?.status === 'paused' && !subOf(after).includes('picture_download_pending')) {
      after = await ctx.ml.updateItem(r.itemId, { status: 'active' });
      if (after?.status === 'active') break;
    }
  }
  if (after?.status === 'active') return { ...base(r), result: 'ok', detail: `Activada (${what})`, link: it?.permalink ?? null };
  const s = subOf(after);
  return { ...base(r), result: 'failed', detail: `Fotos corregidas (${what}) pero Mercado Libre la dejó en ${after?.status}${s.length ? ' (' + s.join(' ') + ')' : ''}`, link: it?.permalink ?? null };
}

// 2) Viva en una categoría "Otros" → pasarla a la que predice ML para ese producto. Si la
//    categoría nueva cobra otra comisión, se ajusta el precio para que siga quedando lo mismo.
async function recategorize(ctx: Ctx, r: AuditRow, dryRun: boolean): Promise<RepairRow> {
  const it: any = await ctx.ml.getItem(r.itemId);
  if (it?.status !== 'active' && it?.status !== 'paused') return { ...base(r), result: 'skipped', detail: `Estado ${it?.status}: no se toca` };
  const from = await ctx.catPath(String(it.category_id));
  if (!isGenericCategory(from)) return { ...base(r), result: 'skipped', detail: 'Ya está en una categoría específica', from };
  const product = await prisma.product.findUnique({
    where: { id: r.productId },
    select: { name: true, price: true, weight: true, width: true, height: true, depth: true, brand: { select: { name: true } }, tnMapping: { select: { tnProductId: true } } },
  });
  if (!product) return { ...base(r), result: 'skipped', detail: 'El producto ya no existe en el sistema', from };
  // Solo una categoría específica de la MISMA rama donde ya está (ver categoryPick.ts).
  const forced = ctx.overrides?.[r.productId];
  const pick = forced ? { categoryId: forced, path: await ctx.catPath(forced) } : await pickSpecificCategory(String(it.category_id), product.name);
  if (pick && pick.categoryId === String(it.category_id)) return { ...base(r), result: 'skipped', detail: 'Ya está en esa categoría', from };
  if (!pick) return { ...base(r), result: 'skipped', detail: 'Mercado Libre no sugiere una categoría específica dentro de su rubro: hay que elegirla a mano', from };
  const info = { categoryId: pick.categoryId };
  const to = pick.path;

  // Datos obligatorios de la categoría nueva que la publicación todavía no tiene.
  const title = String(it.family_name || it.title || product.name).slice(0, 60);
  const need = missingForCategory(await ctx.catAttrs(info.categoryId), it.attributes, { title, brand: product.brand?.name ?? null });
  if (need.blocking.length) return { ...base(r), result: 'skipped', detail: `La categoría nueva pide datos que no tenemos: ${need.blocking.join(', ')}`, from, to };
  if (dryRun) return { ...base(r), result: 'preview', detail: need.fill.length ? `Se completaría: ${need.fill.map((a) => a.id).join(', ')}` : 'Cambio directo', from, to, link: it?.permalink ?? null };

  await ctx.ml.updateItem(r.itemId, { category_id: info.categoryId, ...(need.fill.length ? { attributes: need.fill } : {}) });

  // Precio: mismo criterio que al publicar (que quede lo mismo que en el local), con la comisión
  // de la categoría nueva. Solo publicaciones sin variaciones de ML; cambios chicos, no saltos.
  let priceNote = '';
  try {
    if (!(Array.isArray(it.variations) && it.variations.length)) {
      const vm = await prisma.variantMeliMapping.findFirst({ where: { mlItemId: r.itemId }, select: { variant: { select: { priceOverride: true } } } });
      const storePrice = Number(vm?.variant?.priceOverride ?? product.price) || 0;
      if (storePrice > 0) {
        const pctx = await pricingCtxOf(ctx.holder, String(it.listing_type_id || LISTING));
        const t = await targetPriceFor(pctx, { categoryId: info.categoryId, storePrice, product: await dimensionsFor(product) });
        const cur = Number(it.price) || 0;
        const diff = Math.abs(t.price - cur);
        if (cur > 0 && diff >= 10 && diff / cur <= 0.1) {
          await ctx.ml.updateItem(r.itemId, { price: t.price });
          priceNote = ` · precio ${cur} → ${t.price}`;
        }
      }
    }
  } catch (err: any) { priceNote = ` · precio sin ajustar (${mlErrorText(err).slice(0, 120)})`; }
  return { ...base(r), result: 'ok', detail: `Categoría cambiada${priceNote}`, from, to, link: it?.permalink ?? null };
}

// 3) Dadas de baja por ML → desvincular y publicar de nuevo en una categoría específica.
async function republish(ctx: Ctx, unit: AuditRow[], dryRun: boolean): Promise<RepairRow> {
  const r = unit[0];
  const dead: string[] = [];
  for (const u of unit) {
    const it: any = await ctx.ml.getItem(u.itemId);
    const sub: string[] = Array.isArray(it?.sub_status) ? it.sub_status.map(String) : [];
    if (it?.status === 'closed' || sub.includes('forbidden')) dead.push(u.itemId);
  }
  if (!dead.length) return { ...base(r), result: 'skipped', detail: 'Ya no figura dada de baja: no se toca' };
  const product = await prisma.product.findUnique({ where: { id: r.productId }, select: { name: true } });
  if (!product) return { ...base(r), result: 'skipped', detail: 'El producto ya no existe en el sistema' };
  const forced = ctx.overrides?.[r.productId];
  const info = forced ? { categoryId: forced, generic: false } : await resolveMlCategoryInfo(r.productId, product.name);
  if (!info || info.generic) return { ...base(r), result: 'skipped', detail: 'Mercado Libre no sugiere una categoría específica: hay que elegirla a mano', from: r.categoryName };
  const to = await ctx.catPath(info.categoryId);
  if (isGenericCategory(to)) return { ...base(r), result: 'skipped', detail: 'La categoría sugerida también es genérica', from: r.categoryName, to };
  const newTitle = ctx.titles[r.productId] ? String(ctx.titles[r.productId]).slice(0, 60) : undefined;
  // Misma categoría solo si cambia el título (ML la había bajado por cómo la clasificó por el título).
  if (info.categoryId === r.categoryId && !newTitle) return { ...base(r), result: 'skipped', detail: 'La categoría sugerida es la misma en la que Mercado Libre la dio de baja: revisar a mano', from: r.categoryName, to };
  if (dryRun) return { ...base(r), result: 'preview', detail: `Se publicaría de nuevo (${dead.length} ${dead.length === 1 ? 'publicación' : 'publicaciones'})${newTitle ? ' como "' + newTitle + '"' : ''}`, from: r.categoryName, to };

  // Desvincular las dadas de baja (en ML no se toca nada).
  await prisma.variantMeliMapping.deleteMany({ where: { mlItemId: { in: dead } } });
  await prisma.productMeliMapping.deleteMany({ where: { productId: r.productId, mlItemId: { in: dead } } });
  const left = await prisma.variantMeliMapping.count({ where: { variant: { productId: r.productId } } });
  if (left === 0) await prisma.productMeliMapping.deleteMany({ where: { productId: r.productId } });

  const extraAttrs = ctx.attrs[r.productId];
  const one = await publishOne(r.productId, { listingTypeId: LISTING, pricing: 'target', priceFactor: 1, requireSpecific: true, categoryId: forced, ...(newTitle ? { title: newTitle } : {}), ...(extraAttrs?.length ? { extraAttrsByProduct: { [r.productId]: extraAttrs } } : {}) }, ctx.holder);
  const res = one.res;
  if (res?.ok && !res.alreadyLinked) {
    return { ...base(r), result: 'ok', detail: `Publicada de nuevo${Number(res.count) > 1 ? ` (${res.count} publicaciones)` : ''} a $${one.mlPrice ?? '?'}`, from: r.categoryName, to, newItemId: res.itemId, link: res.permalink ?? null };
  }
  if (res?.ok) return { ...base(r), result: 'skipped', detail: 'No había variantes con stock para publicar de nuevo', from: r.categoryName, to };
  if (left === 0) await prisma.product.update({ where: { id: r.productId }, data: { publishedMeli: false } }).catch(() => null);
  const failed: RepairRow = { ...base(r), result: 'failed', detail: publishFailureReason(res), from: r.categoryName, to };
  if (res?.error === 'ml_rejected' && isHardStop(res)) { const e: any = new Error(failed.detail); e.response = { status: 429 }; throw e; }
  return failed;
}
