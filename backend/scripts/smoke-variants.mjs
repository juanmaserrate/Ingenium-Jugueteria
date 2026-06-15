const BASE = 'https://ingenium-jugueteria-production-0632.up.railway.app';
let T = '';
const out = [];
const rec = (n, ok, d) => { out.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' :: ' + d : ''}`); };
async function call(p, o = {}) {
  const r = await fetch(`${BASE}${p}`, { method: o.method || 'GET', headers: { 'Content-Type': 'application/json', ...(T ? { Authorization: `Bearer ${T}` } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, payload: ct.includes('json') ? await r.json().catch(() => null) : await r.text() };
}
const TAG = 'ZZTEST-var-' + Date.now().toString(36);
async function main() {
  T = (await call('/auth/login-pin', { method: 'POST', body: { branchId: 'br_lomas', userId: 'u_lomas', pin: '1111' } })).payload?.token;
  const pid = 'prod_' + TAG, vM = 'var_' + TAG + '_m', vL = 'var_' + TAG + '_l';
  const cp = await call('/api/products', { method: 'POST', body: {
    id: pid, code: 'SKU-' + TAG, name: TAG + ' Disfraz', cost: 100, price: 200,
    variants: [
      { id: vM, name: 'M', attributes: { Talle: 'M' }, stocks: [{ branchId: 'br_lomas', qty: 5 }, { branchId: 'br_banfield', qty: 3 }] },
      { id: vL, name: 'L', attributes: { Talle: 'L' }, stocks: [{ branchId: 'br_lomas', qty: 2 }] },
    ],
  } });
  rec('POST producto con 2 variantes', cp.status === 200 && (cp.payload?.variants || []).length === 2, `status ${cp.status} variants ${cp.payload?.variants?.length}`);
  const stOf = (prod, vid, br) => (prod.variants.find(v => v.id === vid)?.stocks || []).find(s => s.branchId === br)?.qty;
  let g = await call(`/api/products/${pid}`);
  rec('stock inicial M(L5/B3) L(L2)', stOf(g.payload, vM, 'br_lomas') === 5 && stOf(g.payload, vM, 'br_banfield') === 3 && stOf(g.payload, vL, 'br_lomas') === 2,
    `M-L ${stOf(g.payload, vM, 'br_lomas')} M-B ${stOf(g.payload, vM, 'br_banfield')} L-L ${stOf(g.payload, vL, 'br_lomas')}`);

  // Vender 2 de la variante M en Lomas
  const sale = await call('/api/sales', { method: 'POST', body: {
    branchId: 'br_lomas', items: [{ variantId: vM, qty: 2, unitPrice: 200, priceOverridden: false }],
    payments: [{ methodId: 'cash', methodName: 'Efectivo', amount: 400, affectsCash: true }], source: 'pos',
  } });
  rec('venta variante M', sale.status === 200, `status ${sale.status}`);
  g = await call(`/api/products/${pid}`);
  rec('M-Lomas 5->3, L-Lomas intacto (2)', stOf(g.payload, vM, 'br_lomas') === 3 && stOf(g.payload, vL, 'br_lomas') === 2,
    `M-L ${stOf(g.payload, vM, 'br_lomas')} L-L ${stOf(g.payload, vL, 'br_lomas')}`);

  // setStock directo a la variante L
  const ss = await call('/api/stock/set', { method: 'POST', body: { variantId: vL, branchId: 'br_banfield', qty: 9 } });
  rec('setStock variante L Banfield=9', ss.status === 200 && ss.payload?.qty === 9, `status ${ss.status} qty ${ss.payload?.qty}`);

  // cleanup
  if (sale.payload?.id) await call(`/api/sales/${sale.payload.id}/cancel`, { method: 'POST', body: { reason: TAG } });
  const del = await call(`/api/products/${pid}`, { method: 'DELETE' });
  rec('cleanup delete', del.status === 204 || del.status === 200, `status ${del.status}`);

  console.log(`\n${out.filter(Boolean).length}/${out.length} PASS`);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
