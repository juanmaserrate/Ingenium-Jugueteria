import { prisma } from '../db.js';
import { requireMlClient } from './client.js';
import { isGenericCategory, summarizeAudit, type AuditRow } from './massPure.js';

// Auditoría de las publicaciones vinculadas: lee cada una EN VIVO de Mercado Libre (estado,
// motivo, categoría, envío, fotos, ficha) y arma un resumen. Solo lee; no modifica nada.
// Corre en el servidor (son miles de publicaciones) y la pantalla consulta el avance.

type AuditState = {
  status: 'running' | 'done' | 'error';
  startedAt: string;
  finishedAt: string | null;
  total: number;
  done: number;
  message: string | null;
  rows: AuditRow[];
  summary: ReturnType<typeof summarizeAudit> | null;
  qualitySample: any[]; // respuesta cruda de la API de calidad de ML para algunas activas
};

const KV = { collection: 'ml_mass', key: 'audit' };
let audit: AuditState | null = null;

async function save(a: AuditState) {
  await prisma.kvItem.upsert({
    where: { collection_key: { collection: KV.collection, key: KV.key } },
    update: { value: a as any }, create: { collection: KV.collection, key: KV.key, value: a as any },
  }).catch(() => {});
}
async function load(): Promise<AuditState | null> {
  if (audit) return audit;
  const row = await prisma.kvItem.findUnique({ where: { collection_key: { collection: KV.collection, key: KV.key } } }).catch(() => null);
  const v = (row?.value as AuditState) ?? null;
  // Si el servidor se reinició con la auditoría corriendo, quedó a medias.
  return v && v.status === 'running' ? { ...v, status: 'error', message: 'Se interrumpió: volvé a lanzarla.' } : v;
}

export async function auditStatus() {
  const a = await load();
  return a ? { status: a.status, startedAt: a.startedAt, finishedAt: a.finishedAt, total: a.total, done: a.done, message: a.message, summary: a.summary, qualitySample: a.qualitySample } : null;
}

export async function auditRows(filter?: string): Promise<AuditRow[]> {
  const a = await load();
  const rows = a?.rows ?? [];
  if (filter === 'finalized') return rows.filter((r) => r.finalized);
  if (filter === 'generic') return rows.filter((r) => r.genericCategory);
  if (filter === 'no_shipping') return rows.filter((r) => r.status === 'active' && r.shippingMode !== 'me2');
  return rows;
}

// since: solo las vinculadas desde esa fecha (por defecto, todas las vinculadas).
export function startAudit(since?: Date | null) {
  if (audit?.status === 'running') return { started: false, reason: 'Ya hay una auditoría corriendo' };
  audit = { status: 'running', startedAt: new Date().toISOString(), finishedAt: null, total: 0, done: 0, message: null, rows: [], summary: null, qualitySample: [] };
  const mine = audit;
  void run(mine, since ?? null).catch(async (err) => {
    mine.status = 'error'; mine.finishedAt = new Date().toISOString(); mine.message = String(err?.message ?? 'error');
    await save(mine);
  });
  return { started: true };
}

async function run(a: AuditState, since: Date | null) {
  const ml = await requireMlClient();
  const maps = await prisma.variantMeliMapping.findMany({
    where: since ? { createdAt: { gte: since } } : undefined,
    select: { mlItemId: true, variant: { select: { product: { select: { id: true, name: true, code: true } } } } },
  });
  const byItem = new Map<string, { productId: string; name: string; code: string }>();
  for (const m of maps) if (!byItem.has(m.mlItemId)) byItem.set(m.mlItemId, { productId: m.variant.product.id, name: m.variant.product.name, code: m.variant.product.code });
  const ids = [...byItem.keys()];
  a.total = ids.length;

  const catNames = new Map<string, string>();
  const catName = async (id: string) => {
    if (!id) return '';
    if (!catNames.has(id)) {
      try {
        const c: any = await ml.getCategory(id);
        catNames.set(id, (Array.isArray(c?.path_from_root) ? c.path_from_root.map((x: any) => x.name).join(' > ') : c?.name) || id);
      } catch { catNames.set(id, id); }
    }
    return catNames.get(id)!;
  };

  // De a 4 en paralelo: rápido sin pasarse del límite de ML.
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++];
      const p = byItem.get(id)!;
      try {
        const it: any = await ml.getItem(id);
        const sub: string[] = Array.isArray(it?.sub_status) ? it.sub_status.map(String) : [];
        const categoryId = String(it?.category_id ?? '');
        const categoryName = await catName(categoryId);
        const status = String(it?.status ?? '');
        a.rows.push({
          itemId: id, productId: p.productId, name: p.name, code: p.code,
          status, subStatus: sub, finalized: status === 'closed' || (status === 'under_review' && sub.includes('forbidden')) || sub.includes('forbidden'),
          categoryId, categoryName, genericCategory: isGenericCategory(categoryName),
          shippingMode: it?.shipping?.mode ?? null, logisticType: it?.shipping?.logistic_type ?? null,
          freeShipping: !!it?.shipping?.free_shipping, localPickUp: !!it?.shipping?.local_pick_up,
          pictures: Array.isArray(it?.pictures) ? it.pictures.length : 0,
          attributes: Array.isArray(it?.attributes) ? it.attributes.filter((x: any) => x?.value_name).length : 0,
          price: Number(it?.price) || 0, qty: Number(it?.available_quantity) || 0,
          listingType: it?.listing_type_id ?? null, catalogListing: !!it?.catalog_listing,
          health: it?.health ?? null, permalink: it?.permalink ?? null, titleLength: String(it?.title ?? '').length,
          tags: Array.isArray(it?.tags) ? it.tags.map(String) : [],
        });
      } catch (err: any) {
        a.rows.push({
          itemId: id, productId: p.productId, name: p.name, code: p.code, status: 'error', subStatus: [String(err?.response?.status ?? '')],
          finalized: false, categoryId: '', categoryName: '', genericCategory: false, shippingMode: null, logisticType: null, freeShipping: false,
          localPickUp: false, pictures: 0, attributes: 0, price: 0, qty: 0, listingType: null, catalogListing: false, health: null, permalink: null, titleLength: 0, tags: [],
        });
      }
      a.done++;
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);

  // Qué dice la API de calidad de ML sobre algunas publicaciones activas (para saber qué pide).
  const actives = a.rows.filter((r) => r.status === 'active').slice(0, 4);
  for (const r of actives) {
    try { a.qualitySample.push({ itemId: r.itemId, name: r.name, data: await ml.itemPerformance(r.itemId) }); }
    catch (err: any) { a.qualitySample.push({ itemId: r.itemId, name: r.name, error: err?.response?.status ?? err?.message, detail: err?.response?.data?.message ?? null }); }
  }

  a.summary = summarizeAudit(a.rows);
  a.status = 'done'; a.finishedAt = new Date().toISOString();
  await save(a);
}

// Desvincula del sistema las publicaciones que ML dio de baja (no se pueden reactivar por
// API: hay que publicarlas de nuevo, bien categorizadas). NO borra nada en ML. Los productos
// vuelven a quedar "listos para publicar" en el próximo análisis.
export async function unlinkFinalized() {
  const a = await load();
  if (!a || a.status !== 'done') return { ok: false, reason: 'Primero hay que correr la auditoría' };
  const dead = a.rows.filter((r) => r.finalized).map((r) => r.itemId);
  if (!dead.length) return { ok: true, unlinked: 0, products: 0 };
  const maps = await prisma.variantMeliMapping.findMany({ where: { mlItemId: { in: dead } }, select: { id: true, variant: { select: { productId: true } } } });
  const productIds = [...new Set(maps.map((m) => m.variant.productId))];
  const del = await prisma.variantMeliMapping.deleteMany({ where: { id: { in: maps.map((m) => m.id) } } });
  await prisma.productMeliMapping.deleteMany({ where: { mlItemId: { in: dead } } });
  // Productos que quedaron sin ninguna publicación vinculada: dejan de figurar como publicados.
  let cleared = 0;
  for (const pid of productIds) {
    const left = await prisma.variantMeliMapping.count({ where: { variant: { productId: pid } } });
    if (left === 0) {
      await prisma.productMeliMapping.deleteMany({ where: { productId: pid } });
      await prisma.product.update({ where: { id: pid }, data: { publishedMeli: false } }).catch(() => null);
      cleared++;
    }
  }
  return { ok: true, unlinked: del.count, products: cleared };
}
