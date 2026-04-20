// CRUD de productos + operaciones de stock por sucursal.
import { put, del, get, getAll, newId, stockId, tx } from '../core/db.js';
import * as Audit from '../core/audit.js';
import { emit, EV } from '../core/events.js';

export async function list() { return getAll('products'); }
export async function byId(id) { return get('products', id); }

export async function save(data) {
  const isNew = !data.id;
  const before = isNew ? null : await get('products', data.id);
  const now = new Date().toISOString();
  const rec = {
    id: data.id || newId('prod'),
    code: data.code || `SKU-${Date.now().toString().slice(-6)}`,
    name: (data.name || '').trim(),
    cost: Number(data.cost) || 0,
    margin_pct: Number(data.margin_pct) || 0,
    price: Number(data.price) || 0,
    category_id: data.category_id || null,
    brand_id: data.brand_id || null,
    supplier_id: data.supplier_id || null,
    subcategory_id: data.subcategory_id || null,
    published_meli: !!data.published_meli,
    variants_count: Number(data.variants_count) || 0,
    created_at: before?.created_at || now,
    updated_at: now,
  };
  await put('products', rec);
  await Audit.log({
    action: isNew ? 'create' : 'update',
    entity: 'producto', entity_id: rec.id,
    before, after: rec,
    description: `${isNew ? 'Creó' : 'Actualizó'} producto "${rec.name}" (${rec.code})`,
  });
  if (isNew) {
    const branches = await getAll('branches');
    for (const b of branches) {
      await put('stock', { id: stockId(rec.id, b.id), product_id: rec.id, branch_id: b.id, qty: 0, reserved_qty: 0 });
    }
  }
  emit(EV.PRODUCT_UPDATED, rec);
  return rec;
}

export async function remove(id) {
  const before = await get('products', id);
  await del('products', id);
  const branches = await getAll('branches');
  for (const b of branches) {
    await del('stock', stockId(id, b.id));
  }
  await Audit.log({
    action: 'delete', entity: 'producto', entity_id: id,
    before, description: `Eliminó producto "${before?.name || id}"`,
  });
}

export async function getStock(productId, branchId) {
  return (await get('stock', stockId(productId, branchId))) || { id: stockId(productId, branchId), product_id: productId, branch_id: branchId, qty: 0, reserved_qty: 0 };
}

export async function setStock(productId, branchId, fields) {
  const s = await getStock(productId, branchId);
  const updated = { ...s, ...fields };
  await put('stock', updated);
  emit(EV.STOCK_CHANGED, { product_id: productId, branch_id: branchId });
  return updated;
}

export async function adjustStock(productId, branchId, delta, reason = '') {
  const s = await getStock(productId, branchId);
  const before = { ...s };
  s.qty = Math.max(0, (s.qty || 0) + delta);
  await put('stock', s);
  await Audit.log({
    action: 'stock_adjust', entity: 'stock', entity_id: s.id,
    before, after: s,
    description: `Ajuste stock ${delta > 0 ? '+' : ''}${delta} (${reason})`,
  });
  emit(EV.STOCK_CHANGED, { product_id: productId, branch_id: branchId });
  return s;
}

export async function transferStock({ product_id, from_branch, to_branch, qty }) {
  return tx(['stock'], 'readwrite', async (stores) => {
    const fromId = stockId(product_id, from_branch);
    const toId = stockId(product_id, to_branch);
    const fromStock = await promisify(stores.stock.get(fromId));
    const toStock = await promisify(stores.stock.get(toId)) || { id: toId, product_id, branch_id: to_branch, qty: 0, reserved_qty: 0 };
    if (!fromStock || (fromStock.qty || 0) < qty) throw new Error('Stock insuficiente en sucursal origen');
    fromStock.qty -= qty;
    toStock.qty = (toStock.qty || 0) + qty;
    await promisify(stores.stock.put(fromStock));
    await promisify(stores.stock.put(toStock));
    return { fromStock, toStock };
  });
}

function promisify(req) {
  return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
}
