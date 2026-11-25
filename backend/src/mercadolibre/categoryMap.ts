import { prisma } from '../db.js';
import { Prisma } from '@prisma/client';
import { requireMlClient } from './client.js';
import { ValidationError } from '../utils/errors.js';

// Mapeo de las categorías del sistema a categorías de Mercado Libre. Al publicar, el
// producto sale en la categoría ML de su subcategoría/categoría; si no hay mapeo, se predice
// por el título como antes.

const SITE = 'MLA';

export { tallyPredictions } from './pure.js';
import { isGenericCategory } from './massPure.js';
import { tallyPredictions, pickSpread, tallyListingCategories } from './pure.js';
import { buildSyncPlan } from './syncExisting.js';

async function categoryPath(ml: any, categoryId: string): Promise<{ name: string; path: string; leaf: boolean }> {
  const c: any = await ml.getCategory(categoryId);
  const path = (Array.isArray(c?.path_from_root) ? c.path_from_root : []).map((x: any) => x?.name).filter(Boolean).join(' > ');
  return { name: c?.name ?? categoryId, path: path || c?.name || categoryId, leaf: !(Array.isArray(c?.children_categories) && c.children_categories.length) };
}

export async function listCategoryMap() {
  const [cats, counts] = await Promise.all([
    prisma.category.findMany({ orderBy: { name: 'asc' } }),
    prisma.product.groupBy({ by: ['categoryId'], _count: true, where: { active: true } }),
  ]);
  const n = new Map(counts.map((c) => [c.categoryId, c._count]));
  return cats.map((c) => ({
    id: c.id, name: c.name, products: n.get(c.id) ?? 0,
    mlCategoryId: c.mlCategoryId ?? null, mlCategoryName: c.mlCategoryName ?? null,
    mlDefaultAttrs: Array.isArray(c.mlDefaultAttrs) ? c.mlDefaultAttrs : [],
  }));
}

// Sugiere la categoría ML de una categoría del sistema: predice con títulos reales de sus
// productos (los que tienen más variedad de nombre) y cuenta votos.
export async function suggestForCategory(categoryId: string, sample = 12) {
  const cat = await prisma.category.findUnique({ where: { id: categoryId } });
  if (!cat) throw new ValidationError('Categoría inexistente');
  // Muestra REPARTIDA por toda la categoría (uno cada N, ordenados por nombre). Tomar solo
  // los últimos modificados sesga: una tanda de botellas recién cargadas no representa a "Bazar".
  const all = await prisma.product.findMany({
    where: { categoryId, active: true },
    select: { name: true },
    orderBy: { name: 'asc' },
    take: 3000,
  });
  const titles = pickSpread(all.map((p) => p.name).filter(Boolean), sample);
  if (!titles.length) titles.push(cat.name);

  const ml = await requireMlClient();
  const preds: Array<{ categoryId: string; categoryName?: string | null } | null> = [];
  for (const t of titles) {
    try {
      const res: any = await ml.predictCategory(SITE, t.slice(0, 60));
      const first = Array.isArray(res) ? res[0] : null;
      preds.push(first ? { categoryId: first.category_id, categoryName: first.category_name } : null);
    } catch { preds.push(null); }
  }
  const { total, candidates } = tallyPredictions(preds);
  const top = candidates.slice(0, 4);
  const withPath = [];
  for (const c of top) {
    let path = c.categoryName;
    try { path = (await categoryPath(ml, c.categoryId)).path; } catch { /* queda el nombre */ }
    withPath.push({ ...c, path });
  }
  return { categoryId, name: cat.name, sampled: total, candidates: withPath };
}

// La mejor evidencia: las publicaciones que el vendedor YA tiene. Cada publicación emparejada
// con un producto del inventario dice en qué categoría de ML publica el local los productos de
// esa categoría del sistema. Devuelve, por categoría del sistema, las categorías de ML usadas.
export async function suggestFromListings() {
  const plan = await buildSyncPlan();
  if (!plan.available) throw new ValidationError('Mercado Libre no está conectado');
  const rows = plan.rows.filter((r) => r.productId && r.mlCategoryId && (r.state === 'linked' || r.state === 'match'));
  const products = await prisma.product.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.productId as string))] } },
    select: { id: true, categoryId: true },
  });
  const catOf = new Map(products.map((p) => [p.id, p.categoryId]));
  const tally = tallyListingCategories(rows.map((r) => ({ systemCategoryId: catOf.get(r.productId as string), mlCategoryId: r.mlCategoryId })));

  const ml = await requireMlClient();
  const pathCache = new Map<string, string>();
  const pathOf = async (id: string) => {
    if (!pathCache.has(id)) {
      try { pathCache.set(id, (await categoryPath(ml, id)).path); } catch { pathCache.set(id, id); }
    }
    return pathCache.get(id)!;
  };
  const cats = await prisma.category.findMany({ select: { id: true, name: true } });
  const out = [];
  for (const c of cats) {
    const t = tally.get(c.id);
    if (!t) continue;
    const candidates = [];
    for (const k of t.candidates.slice(0, 5)) candidates.push({ ...k, path: await pathOf(k.categoryId) });
    out.push({ categoryId: c.id, name: c.name, publicaciones: t.total, candidates });
  }
  return { scanned: plan.scanned, usadas: rows.length, categories: out.sort((a, b) => b.publicaciones - a.publicaciones) };
}

// Guarda (o borra, con mlCategoryId=null) el mapeo. Valida contra ML que la categoría exista
// y sea FINAL (ML solo deja publicar en categorías sin subcategorías).
export async function setCategoryMap(categoryId: string, mlCategoryId: string | null) {
  const cat = await prisma.category.findUnique({ where: { id: categoryId } });
  if (!cat) throw new ValidationError('Categoría inexistente');
  if (!mlCategoryId) {
    await prisma.category.update({ where: { id: categoryId }, data: { mlCategoryId: null, mlCategoryName: null, mlDefaultAttrs: Prisma.DbNull } });
    return { id: categoryId, mlCategoryId: null, mlCategoryName: null };
  }
  const id = String(mlCategoryId).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const ml = await requireMlClient();
  let info;
  try { info = await categoryPath(ml, id); }
  catch { throw new ValidationError(`Mercado Libre no reconoce la categoría ${id}`); }
  if (!info.leaf) throw new ValidationError(`"${info.path}" tiene subcategorías: elegí una categoría final`);
  await prisma.category.update({
    where: { id: categoryId },
    data: { mlCategoryId: id, mlCategoryName: info.path, ...(cat.mlCategoryId !== id ? { mlDefaultAttrs: Prisma.DbNull } : {}) },
  });
  return { id: categoryId, mlCategoryId: id, mlCategoryName: info.path };
}

// Categoría ML mapeada para un producto (subcategoría pisa a categoría). null = sin mapeo.
export async function mappedMlCategoryForProduct(productId: string): Promise<string | null> {
  return (await mappedMlForProduct(productId))?.categoryId ?? null;
}

// Categoría ML mapeada + los datos fijos que ML exige ahí (si se cargaron).
export async function mappedMlForProduct(productId: string): Promise<{ categoryId: string; attributes: Array<{ id: string; value_name: string }>; generic: boolean } | null> {
  const p = await prisma.product.findUnique({
    where: { id: productId },
    select: {
      category: { select: { mlCategoryId: true, mlCategoryName: true, mlDefaultAttrs: true } },
      subcategory: { select: { mlCategoryId: true, mlCategoryName: true } },
    },
  });
  if (p?.subcategory?.mlCategoryId) return { categoryId: p.subcategory.mlCategoryId, attributes: [], generic: isGenericCategory(p.subcategory.mlCategoryName) };
  if (!p?.category?.mlCategoryId) return null;
  const raw = Array.isArray(p.category.mlDefaultAttrs) ? (p.category.mlDefaultAttrs as any[]) : [];
  return {
    categoryId: p.category.mlCategoryId,
    attributes: raw.filter((a) => a?.id && a?.value_name).map((a) => ({ id: String(a.id), value_name: String(a.value_name) })),
    generic: isGenericCategory(p.category.mlCategoryName),
  };
}

// Atributos con lista de valores que ML exige en una categoría y que el sistema no puede
// deducir solo (marca, IVA, paquete, código de barras y nombres libres sí los completa).
const AUTO_ATTRS = new Set(['BRAND', 'VALUE_ADDED_TAX', 'IMPORT_DUTY', 'GTIN', 'EMPTY_GTIN_REASON', 'ITEM_CONDITION']);
export async function requiredListAttrs(mlCategoryId: string) {
  const ml = await requireMlClient();
  const attrs: any[] = await ml.getCategoryAttributes(mlCategoryId);
  return (Array.isArray(attrs) ? attrs : [])
    .filter((a) => a?.tags && (a.tags.required || a.tags.catalog_required)
      && Array.isArray(a.values) && a.values.length && !AUTO_ATTRS.has(a.id) && !/^SELLER_PACKAGE_/.test(a.id))
    .map((a) => ({ id: a.id, name: a.name, values: a.values.slice(0, 60).map((v: any) => v.name) }));
}

// Guarda los datos fijos de una categoría ya mapeada.
export async function setCategoryDefaultAttrs(categoryId: string, attributes: Array<{ id: string; name?: string; value_name: string }>) {
  const cat = await prisma.category.findUnique({ where: { id: categoryId } });
  if (!cat) throw new ValidationError('Categoría inexistente');
  if (!cat.mlCategoryId) throw new ValidationError('Primero elegí la categoría de Mercado Libre');
  const clean = attributes.filter((a) => a.id && a.value_name).map((a) => ({ id: a.id, name: a.name ?? a.id, value_name: a.value_name }));
  await prisma.category.update({ where: { id: categoryId }, data: { mlDefaultAttrs: clean.length ? clean : Prisma.DbNull } });
  return { id: categoryId, mlDefaultAttrs: clean };
}
