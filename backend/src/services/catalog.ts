import { prisma } from '../db.js';
import { randomId } from '../utils/crypto.js';
import { logAudit, AUDIT_ACTIONS } from '../utils/audit.js';
import { ValidationError } from '../utils/errors.js';

// =========================================================
// CATÁLOGO: categorías, subcategorías, marcas, proveedores
// Backend-first. El frontend cachea estos datos en IndexedDB.
// =========================================================

// El front usa snake_case (category_id); Prisma usa camelCase (categoryId).
// Serializamos subcategorías a snake para mantener el contrato que ya usan los módulos del front.
const subToFront = (s: { id: string; name: string; categoryId: string | null }) => ({ id: s.id, name: s.name, category_id: s.categoryId });

/** Catálogo completo en un solo round-trip (para el sync inicial del front). */
export async function getCatalog() {
  const [categories, subcategories, brands, suppliers] = await Promise.all([
    prisma.category.findMany({ orderBy: { name: 'asc' } }),
    prisma.subcategory.findMany({ orderBy: { name: 'asc' } }),
    prisma.brand.findMany({ orderBy: { name: 'asc' } }),
    prisma.supplier.findMany({ orderBy: { name: 'asc' } }),
  ]);
  return { categories, subcategories: subcategories.map(subToFront), brands, suppliers };
}

// ---------- Categorías ----------
export async function listCategories() {
  return prisma.category.findMany({ orderBy: { name: 'asc' } });
}
export async function upsertCategory(data: { id?: string; name: string }, userId?: string) {
  const id = data.id ?? randomId();
  const before = await prisma.category.findUnique({ where: { id } });
  const rec = await prisma.category.upsert({
    where: { id },
    create: { id, name: data.name },
    update: { name: data.name },
  });
  await logAudit({ userId, action: before ? AUDIT_ACTIONS.UPDATE : AUDIT_ACTIONS.CREATE, entity: 'category', entityId: id, before, after: rec });
  return rec;
}
export async function deleteCategory(id: string, userId?: string) {
  const before = await prisma.category.findUnique({ where: { id } });
  await prisma.category.delete({ where: { id } });
  await logAudit({ userId, action: AUDIT_ACTIONS.DELETE, entity: 'category', entityId: id, before });
}

// ---------- Subcategorías ----------
export async function listSubcategories() {
  const subs = await prisma.subcategory.findMany({ orderBy: { name: 'asc' } });
  return subs.map(subToFront);
}
// Acepta categoryId (camel) o category_id (snake, como manda el front).
export async function upsertSubcategory(data: { id?: string; name: string; categoryId?: string | null; category_id?: string | null }, userId?: string) {
  const id = data.id ?? randomId();
  const categoryId = data.categoryId ?? data.category_id ?? null;
  if (categoryId) {
    const cat = await prisma.category.findUnique({ where: { id: categoryId } });
    if (!cat) throw new ValidationError(`Categoría ${categoryId} no existe`);
  }
  const before = await prisma.subcategory.findUnique({ where: { id } });
  const rec = await prisma.subcategory.upsert({
    where: { id },
    create: { id, name: data.name, categoryId: categoryId as any },
    update: { name: data.name, categoryId: categoryId ?? undefined },
  });
  await logAudit({ userId, action: before ? AUDIT_ACTIONS.UPDATE : AUDIT_ACTIONS.CREATE, entity: 'subcategory', entityId: id, before, after: rec });
  return subToFront(rec);
}
export async function deleteSubcategory(id: string, userId?: string) {
  const before = await prisma.subcategory.findUnique({ where: { id } });
  await prisma.subcategory.delete({ where: { id } });
  await logAudit({ userId, action: AUDIT_ACTIONS.DELETE, entity: 'subcategory', entityId: id, before });
}

// ---------- Marcas ----------
export async function listBrands() {
  return prisma.brand.findMany({ orderBy: { name: 'asc' } });
}
export async function upsertBrand(data: { id?: string; name: string }, userId?: string) {
  const id = data.id ?? randomId();
  const before = await prisma.brand.findUnique({ where: { id } });
  const rec = await prisma.brand.upsert({
    where: { id },
    create: { id, name: data.name },
    update: { name: data.name },
  });
  await logAudit({ userId, action: before ? AUDIT_ACTIONS.UPDATE : AUDIT_ACTIONS.CREATE, entity: 'brand', entityId: id, before, after: rec });
  return rec;
}
export async function deleteBrand(id: string, userId?: string) {
  const before = await prisma.brand.findUnique({ where: { id } });
  await prisma.brand.delete({ where: { id } });
  await logAudit({ userId, action: AUDIT_ACTIONS.DELETE, entity: 'brand', entityId: id, before });
}

// ---------- Proveedores ----------
type SupplierInput = { id?: string; name: string; phone?: string | null; email?: string | null; address?: string | null; cuit?: string | null; notes?: string | null };
export async function listSuppliers() {
  return prisma.supplier.findMany({ orderBy: { name: 'asc' } });
}
export async function upsertSupplier(data: SupplierInput, userId?: string) {
  const id = data.id ?? randomId();
  const before = await prisma.supplier.findUnique({ where: { id } });
  const payload = {
    name: data.name,
    phone: data.phone ?? null,
    email: data.email ?? null,
    address: data.address ?? null,
    cuit: data.cuit ?? null,
    notes: data.notes ?? null,
  };
  const rec = await prisma.supplier.upsert({
    where: { id },
    create: { id, ...payload },
    update: payload,
  });
  await logAudit({ userId, action: before ? AUDIT_ACTIONS.UPDATE : AUDIT_ACTIONS.CREATE, entity: 'supplier', entityId: id, before, after: rec });
  return rec;
}
export async function deleteSupplier(id: string, userId?: string) {
  const before = await prisma.supplier.findUnique({ where: { id } });
  await prisma.supplier.delete({ where: { id } });
  await logAudit({ userId, action: AUDIT_ACTIONS.DELETE, entity: 'supplier', entityId: id, before });
}

/**
 * Alta masiva de proveedores por nombre (para importar listados). Dedup
 * case-insensitive contra los existentes; crea solo los que faltan.
 */
export async function bulkCreateSuppliers(names: string[], userId?: string) {
  const clean = names.map((n) => (n || '').trim()).filter(Boolean);
  const existing = await prisma.supplier.findMany({ select: { name: true } });
  const have = new Set(existing.map((s) => s.name.trim().toLowerCase()));
  const seen = new Set<string>();
  let created = 0;
  for (const name of clean) {
    const key = name.toLowerCase();
    if (have.has(key) || seen.has(key)) continue;
    seen.add(key);
    await prisma.supplier.create({ data: { id: randomId(), name } });
    created++;
  }
  await logAudit({ userId, action: AUDIT_ACTIONS.CREATE, entity: 'supplier', description: `Alta masiva: ${created} proveedores nuevos` });
  return { created, skipped: clean.length - created };
}
