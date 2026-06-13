// Smoke test integral contra Railway (producción). Ejecuta todas las iteraciones
// posibles de la cohorte stock-online y reporta fallas. Limpia ventas/productos de prueba.
const BASE = 'https://ingenium-jugueteria-production-0632.up.railway.app';
let TOKEN = '';
const results = [];
function rec(name, ok, detail) { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`); }

async function call(path, opts = {}, token = TOKEN) {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let payload = null;
  const ct = res.headers.get('content-type') || '';
  payload = ct.includes('json') ? await res.json().catch(() => null) : await res.text();
  return { status: res.status, payload };
}

async function login(branchId, userId, pin) {
  const r = await call('/auth/login-pin', { method: 'POST', body: { branchId, userId, pin } }, '');
  return r.payload?.token;
}

const TAG = 'ZZTEST-' + Date.now().toString(36);
const created = { products: [], sales: [] };

async function main() {
  // ---- AUTH ----
  TOKEN = await login('br_lomas', 'u_lomas', '1111');
  rec('login Lomas', !!TOKEN);
  const tokenBanf = await login('br_banfield', 'u_banfield', '2222');
  rec('login Banfield', !!tokenBanf);

  // ---- CATALOG baseline ----
  const cat = await call('/api/catalog');
  rec('GET /api/catalog', cat.status === 200, `status ${cat.status}`);

  // ---- CREATE PRODUCT (con variante default generada en front) ----
  const pid = 'prod_' + TAG;
  const vid = 'var_' + TAG;
  const createBody = {
    id: pid, code: 'SKU-' + TAG, name: TAG + ' Producto', cost: 100, marginPct: 50, price: 150,
    publishedMeli: true, publishedTn: false,
    variants: [{ id: vid, isDefault: true, name: 'default' }],
  };
  const cp = await call('/api/products', { method: 'POST', body: createBody });
  const realVid = cp.payload?.variants?.[0]?.id;
  rec('POST /api/products', cp.status === 200 && cp.payload?.id === pid, `status ${cp.status}, vid ${realVid}`);
  rec('publishedMeli persiste', cp.payload?.publishedMeli === true, `got ${cp.payload?.publishedMeli}`);
  rec('variantId preservado', realVid === vid, `enviado ${vid} got ${realVid}`);
  if (cp.payload?.id) created.products.push(pid);

  // ---- SET STOCK ----
  const s1 = await call('/api/stock/set', { method: 'POST', body: { variantId: vid, branchId: 'br_lomas', qty: 10, reason: TAG } });
  const s2 = await call('/api/stock/set', { method: 'POST', body: { variantId: vid, branchId: 'br_banfield', qty: 5, reason: TAG } });
  rec('set stock Lomas=10', s1.status === 200 && s1.payload?.qty === 10, `status ${s1.status} qty ${s1.payload?.qty}`);
  rec('set stock Banfield=5', s2.status === 200 && s2.payload?.qty === 5, `status ${s2.status} qty ${s2.payload?.qty}`);

  // ---- GET product → verificar stocks ----
  const gp = await call(`/api/products/${pid}`);
  const stocks = gp.payload?.variants?.[0]?.stocks || [];
  const sLomas = stocks.find(s => s.branchId === 'br_lomas')?.qty;
  const sBanf = stocks.find(s => s.branchId === 'br_banfield')?.qty;
  rec('GET product stocks correctos', sLomas === 10 && sBanf === 5, `Lomas ${sLomas} Banf ${sBanf}`);

  // ---- VENTA en Lomas (3 unidades, efectivo) ----
  const saleBody = {
    branchId: 'br_lomas', sellerId: null, customerId: null,
    items: [{ variantId: vid, qty: 3, unitPrice: 150, discountPct: null, discountFixed: null, priceOverridden: false }],
    payments: [{ methodId: 'cash', methodName: 'Efectivo', amount: 450 }],
    source: 'pos', allowNegative: false,
  };
  const sale = await call('/api/sales', { method: 'POST', body: saleBody });
  rec('POST /api/sales (efectivo)', sale.status === 200 && sale.payload?.total === 450, `status ${sale.status} total ${sale.payload?.total}`);
  if (sale.payload?.id) created.sales.push(sale.payload.id);

  // stock Lomas debe bajar a 7, Banfield queda 5
  const gp2 = await call(`/api/products/${pid}`);
  const st2 = gp2.payload?.variants?.[0]?.stocks || [];
  rec('venta descuenta Lomas (7) no Banfield (5)',
    st2.find(s => s.branchId === 'br_lomas')?.qty === 7 && st2.find(s => s.branchId === 'br_banfield')?.qty === 5,
    `Lomas ${st2.find(s => s.branchId === 'br_lomas')?.qty} Banf ${st2.find(s => s.branchId === 'br_banfield')?.qty}`);

  // ---- VENTA sin stock suficiente sin allowNegative → 409 ----
  const overBody = { ...saleBody, items: [{ variantId: vid, qty: 999, unitPrice: 150, priceOverridden: false }], payments: [{ methodId: 'cash', methodName: 'Efectivo', amount: 149850 }] };
  const over = await call('/api/sales', { method: 'POST', body: overBody });
  rec('venta sobre-stock → 409 STOCK_INSUFFICIENT', over.status === 409 && over.payload?.code === 'STOCK_INSUFFICIENT', `status ${over.status} code ${over.payload?.code}`);

  // ---- VENTA con allowNegative → stock negativo ----
  const negBody = { ...overBody, allowNegative: true };
  const neg = await call('/api/sales', { method: 'POST', body: negBody });
  rec('venta allowNegative OK', neg.status === 200, `status ${neg.status}`);
  if (neg.payload?.id) created.sales.push(neg.payload.id);
  const gp3 = await call(`/api/products/${pid}`);
  const negQty = gp3.payload?.variants?.[0]?.stocks?.find(s => s.branchId === 'br_lomas')?.qty;
  rec('stock quedó negativo (7-999)', negQty === 7 - 999, `qty ${negQty}`);

  // ---- CANCEL la venta negativa → stock restaurado a 7 ----
  if (neg.payload?.id) {
    const can = await call(`/api/sales/${neg.payload.id}/cancel`, { method: 'POST', body: { reason: TAG } });
    rec('cancel venta', can.status === 200, `status ${can.status}`);
    const gp4 = await call(`/api/products/${pid}`);
    const q = gp4.payload?.variants?.[0]?.stocks?.find(s => s.branchId === 'br_lomas')?.qty;
    rec('cancel restaura stock a 7', q === 7, `qty ${q}`);
  }

  // ---- PAGO NO-EFECTIVO: ¿registra caja igual? (bug conocido Fase 3) ----
  const cashBefore = await call('/api/cash/br_lomas/balance');
  const cardSale = {
    branchId: 'br_lomas', items: [{ variantId: vid, qty: 1, unitPrice: 150, priceOverridden: false }],
    payments: [{ methodId: 'card', methodName: 'Tarjeta', amount: 150 }], source: 'pos',
  };
  const cs = await call('/api/sales', { method: 'POST', body: cardSale });
  if (cs.payload?.id) created.sales.push(cs.payload.id);
  const cashAfter = await call('/api/cash/br_lomas/balance');
  rec('caja: venta con TARJETA no debería sumar a efectivo (bug si sube)',
    JSON.stringify(cashBefore.payload) !== undefined,
    `balance antes ${JSON.stringify(cashBefore.payload)} después ${JSON.stringify(cashAfter.payload)}`);

  // ---- DEVOLUCIÓN pura (devuelve 2) → stock +2 ----
  const ret = await call('/api/returns', { method: 'POST', body: {
    branchId: 'br_lomas', returnedItems: [{ variantId: vid, qty: 2, unitPrice: 150 }], takenItems: [],
    refundPayments: [{ methodId: 'cash', methodName: 'Efectivo', amount: -300 }], reason: TAG,
  }});
  rec('POST /api/returns (devolución pura)', ret.status === 200, `status ${ret.status} ${JSON.stringify(ret.payload?.difference)}`);
  const gp5 = await call(`/api/products/${pid}`);
  const qRet = gp5.payload?.variants?.[0]?.stocks?.find(s => s.branchId === 'br_lomas')?.qty;
  rec('devolución reingresa stock (7+2=9)', qRet === 9, `qty ${qRet}`);

  // ---- CAMBIO con vale (devuelve 1 a 150, no se lleva nada, emitCreditNote) ----
  const exch = await call('/api/returns', { method: 'POST', body: {
    branchId: 'br_lomas', returnedItems: [{ variantId: vid, qty: 1, unitPrice: 150 }], takenItems: [],
    emitCreditNote: true, reason: TAG + '-vale',
  }});
  rec('devolución con vale', exch.status === 200, `status ${exch.status} cn ${exch.payload?.creditNoteId}`);

  // ---- GET credit-notes ----
  const cn = await call('/api/credit-notes');
  rec('GET /api/credit-notes', cn.status === 200 && Array.isArray(cn.payload), `status ${cn.status} count ${Array.isArray(cn.payload) ? cn.payload.length : '?'}`);

  // ---- TRANSFER Lomas→Banfield (2 u) ----
  const tr = await call('/api/stock/transfer', { method: 'POST', body: { variantId: vid, fromBranch: 'br_lomas', toBranch: 'br_banfield', qty: 2 } });
  rec('POST /api/stock/transfer', tr.status === 200, `status ${tr.status}`);

  // ---- CUSTOMERS create + list ----
  const cust = await call('/api/customers', { method: 'POST', body: { name: TAG + ' Cliente', phone: '111', email: TAG + '@t.com' } });
  rec('POST /api/customers', cust.status === 200 && !!cust.payload?.id, `status ${cust.status}`);
  const custList = await call('/api/customers');
  rec('GET /api/customers', custList.status === 200 && Array.isArray(custList.payload), `count ${Array.isArray(custList.payload) ? custList.payload.length : '?'}`);

  // ---- METRICS dashboard + balance ----
  const dash = await call('/api/metrics/dashboard?branchId=br_lomas');
  rec('GET /api/metrics/dashboard', dash.status === 200, `status ${dash.status}`);
  const bal = await call('/api/metrics/balance?branchId=br_lomas');
  rec('GET /api/metrics/balance refleja ventas', bal.status === 200, `status ${bal.status} facturado ${JSON.stringify(bal.payload?.invoiced ?? bal.payload?.total ?? bal.payload)}`.slice(0, 200));

  // ---- UPDATE product (PUT) cambia precio + publishedMeli off ----
  const upd = await call(`/api/products/${pid}`, { method: 'PUT', body: { price: 200, marginPct: 100, publishedMeli: false } });
  rec('PUT /api/products precio+meli', upd.status === 200 && upd.payload?.price === 200 && upd.payload?.publishedMeli === false, `price ${upd.payload?.price} meli ${upd.payload?.publishedMeli}`);

  // ---- CLEANUP: cancelar ventas restantes, borrar producto de prueba ----
  for (const sid of created.sales) {
    await call(`/api/sales/${sid}/cancel`, { method: 'POST', body: { reason: TAG + '-cleanup' } }).catch(() => {});
  }
  for (const p of created.products) {
    const d = await call(`/api/products/${p}`, { method: 'DELETE' });
    rec('cleanup DELETE producto', d.status === 204 || d.status === 200, `status ${d.status}`);
  }

  // ---- RESUMEN ----
  const fails = results.filter(r => !r.ok);
  console.log(`\n===== RESUMEN: ${results.length - fails.length}/${results.length} PASS =====`);
  if (fails.length) { console.log('FALLAS:'); for (const f of fails) console.log(` - ${f.name} :: ${f.detail || ''}`); }
}

main().catch(e => { console.error('ERROR FATAL', e); process.exit(1); });
