const BASE = 'https://ingenium-jugueteria-production-0632.up.railway.app';
let T = '';
const call = async (p, o = {}) => {
  const r = await fetch(BASE + p, { method: o.method || 'GET', headers: { 'Content-Type': 'application/json', ...(T ? { Authorization: 'Bearer ' + T } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, payload: ct.includes('json') ? await r.json().catch(() => null) : await r.text() };
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getDump() {
  for (let i = 0; i < 3; i++) {
    const d = await call('/api/integrations/tiendanube/catalog-dump');
    if (d.payload && Array.isArray(d.payload.rows) && d.payload.rows.length) return d.payload.rows;
    console.log('  dump vacío/err, reintento', i + 1, '(status', d.status, ')'); await sleep(4000);
  }
  return [];
}

(async () => {
  T = (await call('/auth/login-pin', { method: 'POST', body: { branchId: 'br_lomas', userId: 'u_lomas', pin: '1111' } })).payload?.token;
  const ps = (await call('/api/products')).payload;
  const unl = ps.find(p => !p.tnMapping);
  console.log('Producto sistema sin enlazar:', unl.name, unl.id);
  const rows = await getDump();
  console.log('dump filas:', rows.length);
  if (!rows.length) { console.log('no se pudo traer el catálogo TN'); return; }

  // esperar deploy del fix: link-manual no debe dar 500 (debe dar 200 o 400)
  const probe = rows[0];
  for (let i = 0; i < 16; i++) {
    const t = await call('/api/integrations/tiendanube/link-manual', { method: 'POST', body: { productId: unl.id, tnProductId: probe.tnProductId, tnVariantId: probe.tnVariantId } });
    if (t.status !== 500) { console.log('fix live (status', t.status, ')'); break; }
    console.log('  deploy en curso (500), intento', i + 1); await sleep(15000);
  }

  // probar el camino feliz: primer TN cuyo link-manual devuelva 200
  let okTn = null, msg = '';
  for (const tnp of rows) {
    const lk = await call('/api/integrations/tiendanube/link-manual', { method: 'POST', body: { productId: unl.id, tnProductId: tnp.tnProductId, tnVariantId: tnp.tnVariantId } });
    if (lk.status === 200) { okTn = tnp; break; }
    msg = (lk.payload && lk.payload.error) || lk.status;
  }
  if (!okTn) { console.log('no encontré un TN libre para vincular (último msg:', msg, ')'); return; }
  console.log('VINCULADO ok:', unl.name, '<->', okTn.name, '(tnProduct', okTn.tnProductId, ')');
  const g = (await call('/api/products/' + unl.id)).payload;
  console.log('¿enlazado en sistema?', !!g.tnMapping, '| tnProduct:', g.tnMapping && g.tnMapping.tnProductId);
  await call('/api/integrations/tiendanube/unlink', { method: 'POST', body: { productId: unl.id } });
  const g2 = (await call('/api/products/' + unl.id)).payload;
  console.log('tras desvincular ¿enlazado?', !!g2.tnMapping, '(limpio)');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
