// Verifica el fix de medio de pago en caja (Fase 3). Crea un producto ZZTEST, vende
// con tarjeta (no debe mover caja) y con efectivo (sí), cancela y limpia.
const BASE = 'https://ingenium-jugueteria-production-0632.up.railway.app';
let TOKEN = '';
const out = [];
const rec = (n, ok, d) => { out.push({ n, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' :: ' + d : ''}`); };
async function call(p, o = {}) {
  const res = await fetch(`${BASE}${p}`, { method: o.method || 'GET', headers: { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, payload: ct.includes('json') ? await res.json().catch(() => null) : await res.text() };
}
const TAG = 'ZZTEST-cash-' + Date.now().toString(36);
async function bal() { return (await call('/api/cash/br_lomas/balance')).payload?.balance ?? 0; }
async function main() {
  TOKEN = (await call('/auth/login-pin', { method: 'POST', body: { branchId: 'br_lomas', userId: 'u_lomas', pin: '1111' } })).payload?.token;
  const pid = 'prod_' + TAG, vid = 'var_' + TAG;
  await call('/api/products', { method: 'POST', body: { id: pid, code: 'SKU-' + TAG, name: TAG, cost: 100, price: 100, variants: [{ id: vid, isDefault: true }] } });
  await call('/api/stock/set', { method: 'POST', body: { variantId: vid, branchId: 'br_lomas', qty: 100 } });

  const b0 = await bal();
  // Venta con TARJETA (affectsCash false) → caja NO cambia.
  const card = await call('/api/sales', { method: 'POST', body: { branchId: 'br_lomas', items: [{ variantId: vid, qty: 1, unitPrice: 100, priceOverridden: false }], payments: [{ methodId: 'card', methodName: 'Tarjeta', amount: 100, affectsCash: false }], source: 'pos' } });
  const b1 = await bal();
  rec('venta TARJETA no mueve caja', b1 === b0, `antes ${b0} después ${b1}`);

  // Venta EFECTIVO (affectsCash true) → caja +100.
  const cash = await call('/api/sales', { method: 'POST', body: { branchId: 'br_lomas', items: [{ variantId: vid, qty: 1, unitPrice: 100, priceOverridden: false }], payments: [{ methodId: 'cash', methodName: 'Efectivo', amount: 100, affectsCash: true }], source: 'pos' } });
  const b2 = await bal();
  rec('venta EFECTIVO suma +100 a caja', b2 === b1 + 100, `${b1} -> ${b2}`);

  // Venta MIXTA (50 efvo + 50 tarjeta) → caja +50.
  const mix = await call('/api/sales', { method: 'POST', body: { branchId: 'br_lomas', items: [{ variantId: vid, qty: 1, unitPrice: 100, priceOverridden: false }], payments: [{ methodId: 'cash', methodName: 'Efectivo', amount: 50, affectsCash: true }, { methodId: 'card', methodName: 'Tarjeta', amount: 50, affectsCash: false }], source: 'pos' } });
  const b3 = await bal();
  rec('venta MIXTA suma solo +50 (efvo)', b3 === b2 + 50, `${b2} -> ${b3}`);

  // Cancelar la venta efectivo → caja vuelve a -100 (revierte solo efvo).
  await call(`/api/sales/${cash.payload.id}/cancel`, { method: 'POST', body: { reason: TAG } });
  const b4 = await bal();
  rec('cancel venta efvo revierte -100', b4 === b3 - 100, `${b3} -> ${b4}`);

  // Cancelar venta tarjeta → caja NO cambia.
  await call(`/api/sales/${card.payload.id}/cancel`, { method: 'POST', body: { reason: TAG } });
  const b5 = await bal();
  rec('cancel venta tarjeta no mueve caja', b5 === b4, `${b4} -> ${b5}`);

  // status del día y movements.
  const st = await call('/api/cash/br_lomas/status');
  rec('GET cash/status', st.status === 200 && typeof st.payload?.isOpen === 'boolean', JSON.stringify(st.payload));
  const mv = await call('/api/cash/br_lomas/movements');
  rec('GET cash/movements', mv.status === 200 && Array.isArray(mv.payload), `count ${Array.isArray(mv.payload) ? mv.payload.length : '?'}`);

  // Cleanup: cancelar venta mixta y borrar producto (soft-delete por ventas).
  await call(`/api/sales/${mix.payload.id}/cancel`, { method: 'POST', body: { reason: TAG } });
  const del = await call(`/api/products/${pid}`, { method: 'DELETE' });
  rec('cleanup delete (soft)', del.status === 204, `status ${del.status}`);

  const fails = out.filter(x => !x.ok);
  console.log(`\n===== ${out.length - fails.length}/${out.length} PASS =====`);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
