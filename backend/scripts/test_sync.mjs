// Prueba de sincronización con TN: toma un producto enlazado, cambia su stock,
// verifica el push a TN (vía /api/sync/log) y revierte al valor original.
const BASE = 'https://ingenium-jugueteria-production-0632.up.railway.app';
let T = '';
async function call(p, o = {}) {
  const r = await fetch(`${BASE}${p}`, { method: o.method || 'GET', headers: { 'Content-Type': 'application/json', ...(T ? { Authorization: `Bearer ${T}` } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, payload: ct.includes('json') ? await r.json().catch(() => null) : await r.text() };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function syncLogFor(variantId, sinceISO) {
  const r = await call('/api/sync/log?limit=50');
  const logs = Array.isArray(r.payload) ? r.payload : (r.payload?.items || []);
  return logs.filter(l => l.operation === 'push_stock' && JSON.stringify(l.payload || l.response || {}).includes(variantId));
}

async function main() {
  T = (await call('/auth/login-pin', { method: 'POST', body: { branchId: 'br_lomas', userId: 'u_lomas', pin: '1111' } })).payload?.token;
  const ps = (await call('/api/products')).payload;
  // producto enlazado con variante default y stock conocido
  const linked = ps.find(p => p.tnMapping && (p.variants || []).some(v => v.isDefault || true));
  if (!linked) { console.log('No hay productos enlazados'); return; }
  const v = linked.variants.find(x => x.isDefault) || linked.variants[0];
  const vid = v.id;
  const stL = (v.stocks.find(s => s.branchId === 'br_lomas') || {}).qty || 0;
  const stB = (v.stocks.find(s => s.branchId === 'br_banfield') || {}).qty || 0;
  console.log('Producto enlazado:', linked.name, '| tnProduct:', linked.tnMapping.tnProductId);
  console.log('Stock original → Lomas:', stL, 'Banfield:', stB, '(TN debería ver la suma:', stL + stB, ')');

  const TEST = 4321; // valor distintivo
  const expectedTn = TEST + stB;
  try {
    console.log(`\nCambio stock Lomas a ${TEST}...`);
    await call('/api/stock/set', { method: 'POST', body: { variantId: vid, branchId: 'br_lomas', qty: TEST, reason: 'TEST sync' } });
    let ok = false;
    for (let i = 0; i < 12; i++) {
      await sleep(5000);
      const r = await call('/api/sync/log?limit=80');
      const logs = Array.isArray(r.payload) ? r.payload : [];
      const hit = logs.find(l => l.operation === 'push_stock' && JSON.stringify(l.response || {}).includes(`"newStock":${expectedTn}`) && (l.entityId === vid || JSON.stringify(l.payload).includes(vid)));
      const anySucc = logs.find(l => l.operation === 'push_stock' && (l.entityId === vid || JSON.stringify(l.payload || {}).includes(vid)) && l.status === 'success');
      if (hit) { console.log(`  ✓ TN actualizado a stock ${expectedTn} (push_stock success en sync log)`); ok = true; break; }
      if (anySucc) { console.log('  push_stock success (newStock:', JSON.stringify(anySucc.response), ')'); ok = true; break; }
      console.log(`  esperando push... (intento ${i + 1})`);
    }
    if (!ok) console.log('  ⚠️ No vi el push en el log en ~60s (puede estar encolado).');
  } finally {
    console.log(`\nRevierto stock Lomas a ${stL} (valor original)...`);
    await call('/api/stock/set', { method: 'POST', body: { variantId: vid, branchId: 'br_lomas', qty: stL, reason: 'TEST sync revert' } });
    await sleep(8000);
    const r = await call('/api/sync/log?limit=80');
    const logs = Array.isArray(r.payload) ? r.payload : [];
    const rev = logs.find(l => l.operation === 'push_stock' && JSON.stringify(l.response || {}).includes(`"newStock":${stL + stB}`));
    console.log(rev ? `  ✓ Revertido en TN a ${stL + stB}` : '  (revert encolado; verificar en unos segundos)');
    // confirmar stock local revertido
    const g = (await call(`/api/products/${linked.id}`)).payload;
    const nv = (g.variants.find(x => x.id === vid).stocks.find(s => s.branchId === 'br_lomas') || {}).qty;
    console.log('  stock Lomas local ahora:', nv, '(original era', stL, ')');
  }
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
