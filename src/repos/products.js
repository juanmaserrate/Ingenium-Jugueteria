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
  // Variantes expuestas para el front (editor de inventario + selector del POS).
  const frontVariants = variants.map((v) => {
    const st = {};
    for (const s of v.stocks || []) st[s.branchId] = { qty: s.qty || 0, reserved: s.reservedQty || 0 };
    return {
      id: v.id,
      name: v.name,
      attributes: v.attributes || {},
      code: v.code ?? null,
      barcode: v.barcode ?? null,
      is_default: !!v.isDefault,
      price_override: v.priceOverride ?? null,
      cost_override: v.costOverride ?? null,
      stocks: st,
    };
  });
  // "Tiene variantes" = más de una, o una sola que NO es la default genérica.
  const hasVariants = frontVariants.length > 1
    || (frontVariants.length === 1 && !frontVariants[0].is_default && frontVariants[0].name !== 'default');
  const variantType = (() => {
    for (const v of frontVariants) {
      const k = Object.keys(v.attributes || {})[0];
      if (k) return k;
    }
    return null;
  })();
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
    variants: frontVariants,
    has_variants: hasVariants,
    variant_type: variantType,
    linked_tn: !!bp.tnMapping,
    tn_product_id: bp.tnMapping?.tnProductId ?? null,
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
    // Si el form trae variantes, las creamos con el producto (cada una con su stock por sucursal).
    // Si no, una sola variante "default" (producto simple).
    const variants = Array.isArray(data.variants) && data.variants.length
      ? data.variants.map((v, i) => ({
          id: v.id || newId('var'),
          name: v.name || 'default',
          attributes: v.attributes || {},
          code: v.code || null,
          barcode: v.barcode || null,
          priceOverride: num(v.price_override),
          costOverride: num(v.cost_override),
          isDefault: i === 0 && data.variants.length === 1,
          stocks: Object.entries(v.stocks || {}).map(([branchId, qty]) => ({ branchId, qty: Math.max(0, Number(qty) || 0) })),
        }))
      : [{ id: newId('var'), isDefault: true, name: 'default' }];
    resp = await api('/api/products', { method: 'POST', body: { ...body, id, variants } });
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

// Setea stock absoluto en una sucursal. fields.variantId opcional (si no, la default).
export async function setStock(productId, branchId, fields) {
  const variantId = fields?.variantId || await resolveVariantId(productId);
  if (!variantId) throw new Error('Producto sin variante en el servidor');
  const qty = Math.max(0, Number(fields?.qty) || 0);
  const st = await api('/api/stock/set', {
    method: 'POST',
    body: { variantId, branchId, qty, reason: fields?.reason || 'Ajuste desde inventario' },
  });
  patchCacheStock(productId, branchId, st, variantId);
  emit(EV.STOCK_CHANGED, { product_id: productId, branch_id: branchId });
  return { product_id: productId, branch_id: branchId, qty: st?.qty ?? qty, reserved_qty: st?.reservedQty || 0 };
}

export async function adjustStock(productId, branchId, delta, reason = '', { variantId } = {}) {
  const vid = variantId || await resolveVariantId(productId);
  if (!vid) throw new Error('Producto sin variante en el servidor');
  const st = await api('/api/stock/adjust', {
    method: 'POST',
    body: { variantId: vid, branchId, delta: Math.trunc(Number(delta) || 0), reason },
  });
  patchCacheStock(productId, branchId, st, vid);
  emit(EV.STOCK_CHANGED, { product_id: productId, branch_id: branchId });
  return { product_id: productId, branch_id: branchId, qty: st?.qty || 0, reserved_qty: st?.reservedQty || 0 };
}

export async function transferStock({ product_id, from_branch, to_branch, qty, variantId }) {
  const vid = variantId || await resolveVariantId(product_id);
  if (!vid) throw new Error('Producto sin variante en el servidor');
  await api('/api/stock/transfer', {
    method: 'POST',
    body: { variantId: vid, fromBranch: from_branch, toBranch: to_branch, qty: Math.trunc(Number(qty) || 0) },
  });
  emit(EV.STOCK_CHANGED, { product_id, branch_id: to_branch });
  return { ok: true };
}

// --- CRUD de variantes (el backend sincroniza a TN solo si el producto está publicado) ---
export async function createVariant({ productId, name, attributes, code, barcode, priceOverride, costOverride }) {
  const v = await api('/api/variants', {
    method: 'POST',
    body: { productId, name, attributes: attributes || {}, code: code || null, barcode: barcode || null,
      priceOverride: num(priceOverride), costOverride: num(costOverride) },
  });
  emit(EV.PRODUCT_UPDATED, { id: productId });
  return v;
}

export async function updateVariant(id, fields) {
  const body = {};
  if (fields.name !== undefined) body.name = fields.name;
  if (fields.attributes !== undefined) body.attributes = fields.attributes;
  if (fields.code !== undefined) body.code = fields.code || null;
  if (fields.barcode !== undefined) body.barcode = fields.barcode || null;
  if (fields.priceOverride !== undefined) body.priceOverride = num(fields.priceOverride);
  if (fields.costOverride !== undefined) body.costOverride = num(fields.costOverride);
  const v = await api(`/api/variants/${encodeURIComponent(id)}`, { method: 'PUT', body });
  return v;
}

export async function removeVariant(id) {
  await api(`/api/variants/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// --- Vinculación con Tienda Nube (módulo manual en Inventario) ---
let _tnCatalog = null; // cache del dump de TN (productos simples para elegir)
export async function getTnCatalog(force = false) {
  if (_tnCatalog && !force) return _tnCatalog;
  const resp = await api('/api/integrations/tiendanube/catalog-dump');
  // 1 fila por variante; para vincular ofrecemos productos (dedup por tnProductId, simples primero).
  const byProd = new Map();
  for (const r of (resp?.rows || [])) {
    if (!byProd.has(r.tnProductId)) {
      byProd.set(r.tnProductId, { tnProductId: r.tnProductId, tnVariantId: r.tnVariantId, name: r.name, barcode: r.barcode || '', sku: r.sku || '', price: r.price || '', isVariant: !!r.isVariantProduct });
    }
  }
  _tnCatalog = [...byProd.values()];
  return _tnCatalog;
}

export async function linkTn(productId, tnProductId, tnVariantId) {
  const r = await api('/api/integrations/tiendanube/link-manual', { method: 'POST', body: { productId, tnProductId, tnVariantId } });
  const p = _cache.byId.get(productId);
  if (p) { p.linked_tn = true; p.tn_product_id = tnProductId; }
  emit(EV.PRODUCT_UPDATED, { id: productId });
  return r;
}

export async function unlinkTn(productId) {
  await api('/api/integrations/tiendanube/unlink', { method: 'POST', body: { productId } });
  const p = _cache.byId.get(productId);
  if (p) { p.linked_tn = false; p.tn_product_id = null; }
  emit(EV.PRODUCT_UPDATED, { id: productId });
}

// Sugerencias para autocompletar tipo y valores de variante, juntando lo del catálogo en cache.
export function variantSuggestions() {
  const types = new Set();
  const values = new Set();
  for (const p of _cache.list) {
    for (const v of p.variants || []) {
      for (const [k, val] of Object.entries(v.attributes || {})) {
        if (k) types.add(k);
        if (val) values.add(String(val));
      }
      if (v.name && v.name !== 'default') values.add(v.name);
    }
  }
  return { types: [...types].sort(), values: [...values].sort() };
}

// Actualiza la cache local tras una operación de stock (para que el próximo
// getStock/listStock refleje el nuevo valor sin refetch).
function patchCacheStock(productId, branchId, st, variantId) {
  const p = _cache.byId.get(productId);
  if (!p) return;
  const reserved = st?.reservedQty || 0;
  // Actualizar la variante específica en cache (si la conocemos).
  if (variantId && Array.isArray(p.variants)) {
    const v = p.variants.find((x) => x.id === variantId);
    if (v) { v.stocks = v.stocks || {}; v.stocks[branchId] = { qty: st?.qty || 0, reserved }; }
  }
  p._stocks = p._stocks || [];
  if (Array.isArray(p.variants) && p.variants.length) {
    // Recalcular el agregado por sucursal (suma de variantes).
    const byBranch = {};
    for (const v of p.variants) {
      for (const [bid, s] of Object.entries(v.stocks || {})) {
        const e = byBranch[bid] || { qty: 0, reserved_qty: 0 };
        e.qty += s.qty || 0; e.reserved_qty += s.reserved || 0;
        byBranch[bid] = e;
      }
    }
    p._stocks = Object.entries(byBranch).map(([branch_id, e]) => ({ product_id: productId, branch_id, qty: e.qty, reserved_qty: e.reserved_qty }));
  } else {
    const e = p._stocks.find((s) => s.branch_id === branchId);
    if (e) { e.qty = st?.qty || 0; e.reserved_qty = reserved; }
    else p._stocks.push({ product_id: productId, branch_id: branchId, qty: st?.qty || 0, reserved_qty: reserved });
  }
}
