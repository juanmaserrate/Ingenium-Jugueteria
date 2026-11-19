import { prisma } from '../db.js';
import { requireMlClient } from './client.js';
import { ValidationError } from '../utils/errors.js';

// Mapeo de las categorías del sistema a categorías de Mercado Libre. Al publicar, el
// producto sale en la categoría ML de su subcategoría/categoría; si no hay mapeo, se predice
// por el título como antes.

const SITE = 'MLA';

export { tallyPredictions } from './pure.js';
import { tallyPredictions } from './pure.js';

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
  }));
}

// Sugiere la categoría ML de una categoría del sistema: predice con títulos reales de sus
// productos (los que tienen más variedad de nombre) y cuenta votos.
export async function suggestForCategory(categoryId: string, sample = 8) {
  const cat = await prisma.category.findUnique({ where: { id: categoryId } });
  if (!cat) throw new ValidationError('Categoría inexistente');
  const products = await prisma.product.findMany({
    where: { categoryId, active: true },
    select: { name: true },
    orderBy: { updatedAt: 'desc' },
    take: sample,
  });
  const titles = products.map((p) => p.name).filter(Boolean);
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

// Guarda (o borra, con mlCategoryId=null) el mapeo. Valida contra ML que la categoría exista
// y sea FINAL (ML solo deja publicar en categorías sin subcategorías).
export async function setCategoryMap(categoryId: string, mlCategoryId: string | null) {
  const cat = await prisma.category.findUnique({ where: { id: categoryId } });
  if (!cat) throw new ValidationError('Categoría inexistente');
  if (!mlCategoryId) {
    await prisma.category.update({ where: { id: categoryId }, data: { mlCategoryId: null, mlCategoryName: null } });
    return { id: categoryId, mlCategoryId: null, mlCategoryName: null };
  }
  const id = String(mlCategoryId).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const ml = await requireMlClient();
  let info;
  try { info = await categoryPath(ml, id); }
  catch { throw new ValidationError(`Mercado Libre no reconoce la categoría ${id}`); }
  if (!info.leaf) throw new ValidationError(`"${info.path}" tiene subcategorías: elegí una categoría final`);
  await prisma.category.update({ where: { id: categoryId }, data: { mlCategoryId: id, mlCategoryName: info.path } });
  return { id: categoryId, mlCategoryId: id, mlCategoryName: info.path };
}

// Categoría ML mapeada para un producto (subcategoría pisa a categoría). null = sin mapeo.
export async function mappedMlCategoryForProduct(productId: string): Promise<string | null> {
  const p = await prisma.product.findUnique({
    where: { id: productId },
    select: { category: { select: { mlCategoryId: true } }, subcategory: { select: { mlCategoryId: true } } },
  });
  return p?.subcategory?.mlCategoryId || p?.category?.mlCategoryId || null;
}
