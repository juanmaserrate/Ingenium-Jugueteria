import { prisma } from '../db.js';
import { getTnClient } from '../tiendanube/client.js';

// FOTO MINIATURA de cada producto para la grilla de Inventario.
// Las fotos viven en Tienda Nube (o en el storage propio si se cargaron desde el sistema).
// Guardamos la URL de la PRIMERA foto en products.thumb_url y la grilla las pide de a una página
// (POST /api/products/thumbs con los ids visibles), así el listado de productos no se hace más
// pesado. Se completa con:
//   - una carga inicial (startThumbBackfill) que recorre los productos de Tienda Nube en tandas;
//   - el webhook product/updated de Tienda Nube (cuando cambian las fotos allá);
//   - al pedir miniaturas: las que faltan se buscan en segundo plano (de a pocas).

const KV = { collection: 'thumbs', key: 'backfill' };

const firstTnImage = (tp: any): string | null => {
  const imgs = Array.isArray(tp?.images) ? [...tp.images] : [];
  imgs.sort((a: any, b: any) => (a?.position ?? 0) - (b?.position ?? 0));
  const src = imgs.find((i: any) => i?.src)?.src;
  return src ? String(src) : null;
};

async function localFirstImage(productId: string): Promise<string | null> {
  const im = await prisma.productImage.findFirst({ where: { productId }, orderBy: { position: 'asc' }, select: { url: true } });
  return im?.url ?? null;
}

// Guarda la miniatura de un producto a partir del producto de Tienda Nube (o de su foto propia).
export async function setThumbFromTn(productId: string, tnProduct: any): Promise<string | null> {
  const url = (await localFirstImage(productId)) ?? firstTnImage(tnProduct);
  await prisma.product.update({ where: { id: productId }, data: { thumbUrl: url ?? '' } }).catch(() => null);
  return url;
}

// --- Pedido de la grilla ---
let filling = false;
async function fillMissing(ids: string[]) {
  if (filling || !ids.length) return;
  filling = true;
  try {
    const tn = await getTnClient().catch(() => null);
    for (const id of ids.slice(0, 10)) {
      const m = await prisma.productTnMapping.findUnique({ where: { productId: id }, select: { tnProductId: true } });
      let url = await localFirstImage(id);
      if (!url && m && tn) {
        try { url = firstTnImage(await tn.getProduct(m.tnProductId)); } catch { /* sin foto por ahora */ }
      }
      // '' = buscado y sin foto (para no volver a buscarlo en cada página).
      await prisma.product.update({ where: { id }, data: { thumbUrl: url ?? '' } }).catch(() => null);
      await new Promise((r) => setTimeout(r, 300));
    }
  } finally { filling = false; }
}

export async function thumbsFor(ids: string[]): Promise<Record<string, string | null>> {
  const rows = await prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, thumbUrl: true } });
  const out: Record<string, string | null> = {};
  const missing: string[] = [];
  for (const r of rows) {
    out[r.id] = r.thumbUrl || null;
    if (r.thumbUrl == null) missing.push(r.id);
  }
  if (missing.length) void fillMissing(missing).catch(() => {});
  return out;
}

// --- Carga inicial desde Tienda Nube ---
type Job = { status: 'running' | 'done' | 'error'; startedAt: string; finishedAt: string | null; pages: number; seen: number; updated: number; withoutPhoto: number; local: number; message: string | null };
let job: Job | null = null;

async function save(j: Job) {
  await prisma.kvItem.upsert({
    where: { collection_key: { collection: KV.collection, key: KV.key } },
    update: { value: j as any }, create: { collection: KV.collection, key: KV.key, value: j as any },
  }).catch(() => {});
}

export async function thumbBackfillStatus() {
  if (job) return job;
  const row = await prisma.kvItem.findUnique({ where: { collection_key: { collection: KV.collection, key: KV.key } } }).catch(() => null);
  return (row?.value as Job) ?? null;
}

export function startThumbBackfill() {
  if (job?.status === 'running') return { started: false, reason: 'Ya está corriendo' };
  job = { status: 'running', startedAt: new Date().toISOString(), finishedAt: null, pages: 0, seen: 0, updated: 0, withoutPhoto: 0, local: 0, message: null };
  const mine = job;
  void runBackfill(mine).catch(async (err) => {
    mine.status = 'error'; mine.finishedAt = new Date().toISOString(); mine.message = String(err?.message ?? 'error');
    await save(mine);
  });
  return { started: true };
}

async function runBackfill(j: Job) {
  // 1) Fotos propias (storage del sistema): mandan sobre las de Tienda Nube.
  const locals = await prisma.productImage.findMany({ orderBy: [{ productId: 'asc' }, { position: 'asc' }], select: { productId: true, url: true } });
  const localFirst = new Map<string, string>();
  for (const im of locals) if (!localFirst.has(im.productId) && im.url) localFirst.set(im.productId, im.url);
  for (const [productId, url] of localFirst) {
    await prisma.product.update({ where: { id: productId }, data: { thumbUrl: url } }).catch(() => null);
    j.local++;
  }
  // 2) Tienda Nube: todos los productos en tandas de 200 (solo id e imágenes).
  const tn = await getTnClient();
  if (!tn) throw new Error('Tienda Nube no está conectada');
  const maps = await prisma.productTnMapping.findMany({ select: { productId: true, tnProductId: true } });
  const byTn = new Map(maps.map((m) => [String(m.tnProductId), m.productId]));
  for (let page = 1; page < 500; page++) {
    let list: any[] = [];
    try { list = await tn.listProducts({ page, per_page: 200, fields: 'id,images' }); }
    catch (err: any) {
      // TN devuelve 404 cuando se pasa de la última página.
      if (Number(err?.response?.status) === 404) break;
      throw err;
    }
    if (!Array.isArray(list) || !list.length) break;
    j.pages++;
    for (const tp of list) {
      j.seen++;
      const productId = byTn.get(String(tp?.id));
      if (!productId || localFirst.has(productId)) continue;
      const url = firstTnImage(tp);
      await prisma.product.update({ where: { id: productId }, data: { thumbUrl: url ?? '' } }).catch(() => null);
      if (url) j.updated++; else j.withoutPhoto++;
    }
    if (j.pages % 5 === 0) await save(j);
    await new Promise((r) => setTimeout(r, 600)); // TN: límite de pedidos por segundo
  }
  j.status = 'done'; j.finishedAt = new Date().toISOString();
  await save(j);
}
