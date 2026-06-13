// CRUD de productos + operaciones de stock por sucursal.
// MIGRADO A "TODO ONLINE": el servidor (Postgres) es la única fuente de verdad.
// Todas las funciones llaman al backend vía api(). No se usa IndexedDB.
//
// Mapeo de shapes:
//  - Front: product_id ('prod_xxx'), snake_case, stock por {product_id, branch_id}.
//  - Backend: Variant.id (random), camelCase, stock por {variantId, branchId}.
//  El backend devuelve cada producto con variants[].id y variants[].stocks[], así que
//  el front conoce el variantId leyendo del backend. El POS usa la variante "default".

import { api } from '../core/api.js';
import { newId } from '../core/db.js';
import { emit, EV } from '../core/events.js';

// Cache en memoria de la última lista traída del backend. Sirve para resolver
// product_id → variantId sin un fetch extra por cada operación de stock.
let _cache = { list: [], byId: new Map(), at: 0 };

function num(v) {
  return v != null && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : null;
}

// Backend product (con variants/stocks) → shape que espera el front.
function toFront(bp) {
  if (!bp) return null;
  const variants = bp.variants || [];
  const dv = variants.find((v) => v.isDefault) || variants[0] || null;
  // Stock agregado por sucursal (suma de todas las variantes; el POS usa 1 "default").
  const byBranch = {};
  for (const v of variants) {
    for (const s of v.stocks || []) {
      const e = byBranch[s.branchId] || { qty: 0, reserved_qty: 0 };
      e.qty += s.qty || 0;
      e.reserved_qty += s.reservedQty || 0;
      byBranch[s.branchId] = e;
    }
  }
  const stocks = Object.entries(byBranch).map(([branch_id, e]) => ({
    product_id: bp.id, branch_id, qty: e.qty, reserved_qty: e.reserved_qty,
  }));
  return {
    id: bp.id,
    code: bp.code,
    name: bp.name,
    cost: bp.cost ?? 0,
    margin_pct: bp.marginPct ?? 0,
    price: bp.price ?? 0,
    category_id: bp.categoryId ?? null,
    brand_id: bp.brandId ?? null,
    supplier_id: bp.supplierId ?? null,
    subcategory_id: bp.subcategoryId ?? null,
    published_meli: !!bp.publishedMeli,
    published_tn: !!bp.publishedTn,
    description: bp.description ?? null,
    promotional_price: bp.promotionalPrice ?? null,
    weight: bp.weight ?? null,
    width: bp.width ?? null,
    height: bp.height ?? null,
    depth: bp.depth ?? null,
    seo_title: bp.seoTitle ?? null,
    seo_description: bp.seoDescription ?? null,
    handle: bp.handle ?? null,
    video_url: bp.videoUrl ?? null,
    tn_category_ids: Array.isArray(bp.tnCategoryIds) ? bp.tnCategoryIds : [],
    barcode: dv?.barcode ?? null,
    created_at: bp.createdAt ?? null,
    updated_at: bp.updatedAt ?? null,
    variant_id: dv?.id ?? null,
    _stocks: stocks,
  };
}

// Front data (del formulario) → body del backend.
function toBackendBody(data) {
  const body = {
    code: data.code || `SKU-${Date.now().toString().slice(-6)}`,
    name: (data.name || '').trim(),
    cost: Number(data.cost) || 0,
    marginPct: Number(data.margin_pct) || 0,
    price: Number(data.price) || 0,
    categoryId: data.category_id || null,
    brandId: data.brand_id || null,
    supplierId: data.supplier_id || null,
    subcategoryId: data.subcategory_id || null,
    publishedMeli: !!data.published_meli,
    publishedTn: !!data.published_tn,
    description: data.description || null,
    promotionalPrice: num(data.promotional_price),
    weight: num(data.weight),
    width: num(data.width),
    height: num(data.height),
    depth: num(data.depth),
    seoTitle: data.seo_title || null,
    seoDescription: data.seo_description || null,
    handle: data.handle || null,
    videoUrl: data.video_url || null,
  };
  if (Array.isArray(data.tn_category_ids)) {
    body.tnCategoryIds = data.tn_category_ids.map(Number).filter((n) => !Number.isNaN(n));
  }
  return body;
}

function indexCache(frontList) {
  _cache = {
    list: frontList,
    byId: new Map(frontList.map((p) => [p.id, p])),
    at: Date.now(),
  };
}

export async function list() {
  const raw = await api('/api/products');
  const front = (raw || []).map(toFront).filter(Boolean);
  indexCache(front);
  return front;
}

// Stock plano [{product_id, branch_id, qty, reserved_qty}] derivado de la última lista.
// Si la cache está vacía, trae primero.
export async function listStock() {
  if (!_cache.list.length) await list();
  return _cache.list.flatMap((p) => p._stocks || []);
}

export async function byId(id) {
  const bp = await api(`/api/products/${encodeURIComponent(id)}`);
  return toFront(bp);
}

// Resuelve el variantId "default" de un producto (export público para otros repos).
export async function variantIdOf(productId) {
  return resolveVariantId(productId);
}

// Resuelve el variantId "default" de un producto usando la cache; si no está, lo trae.
async function resolveVariantId(productId) {
  const cached = _cache.byId.get(productId);
  if (cached?.variant_id) return cached.variant_id;
  const bp = await api(`/api/products/${encodeURIComponent(productId)}`);
  const front = toFront(bp);
  if (front) _cache.byId.set(productId, front);
  return front?.variant_id || null;
}

export async function save(data) {
  const isNew = !data.id;
  const body = toBackendBody(data);
  let resp;
  if (isNew) {
    const id = newId('prod');
    // Generamos el variantId en el front para conocerlo desde el origen.
    resp = await api('/api/products', {
      method: 'POST',
      body: { ...body, id, variants: [{ id: newId('var'), isDefault: true, name: 'default' }] },
    });
  } else {
    resp = await api(`/api/products/${encodeURIComponent(data.id)}`, { method: 'PUT', body });
  }
  const front = toFront(resp);
  if (front) {
    _cache.byId.set(front.id, front);
    const idx = _cache.list.findIndex((p) => p.id === front.id);
    if (idx >= 0) _cache.list[idx] = front; else _cache.list.push(front);
  }
  emit(EV.PRODUCT_UPDATED, front);
  return front;
}

export async function remove(id, { keepTn = false } = {}) {
  // keepTn=true → "solo del POS": el backend NO encola el borrado en Tienda Nube.
  const qs = keepTn ? '?keepTn=1' : '';
  await api(`/api/products/${encodeURIComponent(id)}${qs}`, { method: 'DELETE' });
  _cache.byId.delete(id);
  _cache.list = _cache.list.filter((p) => p.id !== id);
  emit(EV.PRODUCT_UPDATED, { id });
}

export async function getStock(productId, branchId) {
  const p = _cache.byId.get(productId);
  const found = p?._stocks?.find((s) => s.branch_id === branchId);
  if (found) return { ...found };
  // Fallback: resolver del backend.
  const variantId = await resolveVariantId(productId);
  if (!variantId) return { product_id: productId, branch_id: branchId, qty: 0, reserved_qty: 0 };
  const st = await api(`/api/stock/${encodeURIComponent(variantId)}/${encodeURIComponent(branchId)}`);
  return { product_id: productId, branch_id: branchId, qty: st?.qty || 0, reserved_qty: st?.reservedQty || 0 };
}

// Setea stock absoluto en una sucursal.
export async function setStock(productId, branchId, fields) {
  const variantId = await resolveVariantId(productId);
  if (!variantId) throw new Error('Producto sin variante en el servidor');
  const qty = Math.max(0, Number(fields?.qty) || 0);
  const st = await api('/api/stock/set', {
    method: 'POST',
    body: { variantId, branchId, qty, reason: fields?.reason || 'Ajuste desde inventario' },
  });
  patchCacheStock(productId, branchId, st);
  emit(EV.STOCK_CHANGED, { product_id: productId, branch_id: branchId });
  return { product_id: productId, branch_id: branchId, qty: st?.qty ?? qty, reserved_qty: st?.reservedQty || 0 };
}

export async function adjustStock(productId, branchId, delta, reason = '') {
  const variantId = await resolveVariantId(productId);
  if (!variantId) throw new Error('Producto sin variante en el servidor');
  const st = await api('/api/stock/adjust', {
    method: 'POST',
    body: { variantId, branchId, delta: Math.trunc(Number(delta) || 0), reason },
  });
  patchCacheStock(productId, branchId, st);
  emit(EV.STOCK_CHANGED, { product_id: productId, branch_id: branchId });
  return { product_id: productId, branch_id: branchId, qty: st?.qty || 0, reserved_qty: st?.reservedQty || 0 };
}

export async function transferStock({ product_id, from_branch, to_branch, qty }) {
  const variantId = await resolveVariantId(product_id);
  if (!variantId) throw new Error('Producto sin variante en el servidor');
  await api('/api/stock/transfer', {
    method: 'POST',
    body: { variantId, fromBranch: from_branch, toBranch: to_branch, qty: Math.trunc(Number(qty) || 0) },
  });
  emit(EV.STOCK_CHANGED, { product_id, branch_id: to_branch });
  return { ok: true };
}

// Actualiza la cache local tras una operación de stock (para que el próximo
// getStock/listStock refleje el nuevo valor sin refetch).
function patchCacheStock(productId, branchId, st) {
  const p = _cache.byId.get(productId);
  if (!p) return;
  p._stocks = p._stocks || [];
  const e = p._stocks.find((s) => s.branch_id === branchId);
  const qty = st?.qty || 0;
  const reserved = st?.reservedQty || 0;
  if (e) { e.qty = qty; e.reserved_qty = reserved; }
  else p._stocks.push({ product_id: productId, branch_id: branchId, qty, reserved_qty: reserved });
}
