// Pruebas de la lógica pura de Mercado Libre (sin base ni red).
// Correr:  npm test   (desde backend/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchListings, normSku, normTitle, type InvProduct, type MlListing } from '../src/mercadolibre/match.js';
import { normalizeQuestion, cleanAnswerText, ANSWER_MAX_CHARS, flexSchedule } from '../src/mercadolibre/questionsPure.js';
import { classifyForMl, isFanOut, priceWithFactor, publishFailureReason, isHardStop, mlProfit, pickListingPrice, freeShippingApplies, solveTargetPrice, netOf, type FeeQuote, type MassProduct, type MassVariant } from '../src/mercadolibre/massPure.js';

test('paquete: usa las medidas del producto y, si faltan, el paquete estandar', async () => {
  const { packageFor, packageAttributes } = await import('../src/mercadolibre/massPure.js');
  const std = packageFor({});
  assert.deepEqual(std, { weightG: 500, heightCm: 15, widthCm: 20, lengthCm: 20, assumed: true });
  assert.deepEqual(packageAttributes(std), [
    { id: 'SELLER_PACKAGE_WEIGHT', value_name: '500 g' }, { id: 'SELLER_PACKAGE_HEIGHT', value_name: '15 cm' },
    { id: 'SELLER_PACKAGE_WIDTH', value_name: '20 cm' }, { id: 'SELLER_PACKAGE_LENGTH', value_name: '20 cm' },
  ]);
  // el sistema guarda el peso en kg
  assert.deepEqual(packageFor({ weight: 1.25, height: 30, width: 40.4, depth: 12 }), { weightG: 1250, heightCm: 30, widthCm: 40, lengthCm: 12, assumed: false });
  // dato parcial: se completa lo que falta y se marca como supuesto
  assert.deepEqual(packageFor({ weight: 0.2, height: null, width: 0, depth: undefined }), { weightG: 200, heightCm: 15, widthCm: 20, lengthCm: 20, assumed: true });
});

test('paquete: lo que falta en el sistema se toma de Tienda Nube', async () => {
  const { tnDimensions, mergeDimensions, packageFor } = await import('../src/mercadolibre/massPure.js');
  const tn = tnDimensions({ variants: [{ weight: '0.350', height: '12.00', width: '25.00', depth: '8.00' }, { weight: '0.500', height: '10', width: '25', depth: null }] });
  assert.deepEqual(tn, { weight: 0.5, height: 12, width: 25, depth: 8 });
  assert.deepEqual(packageFor(mergeDimensions({ weight: null, height: null, width: null, depth: null }, tn)), { weightG: 500, heightCm: 12, widthCm: 25, lengthCm: 8, assumed: false });
  // lo cargado en el sistema tiene prioridad
  assert.deepEqual(mergeDimensions({ weight: 2, height: null, width: 30, depth: 0 }, tn), { weight: 2, height: 12, width: 30, depth: 8 });
  // TN en cero o sin variantes: queda el estandar
  assert.equal(packageFor(mergeDimensions({}, tnDimensions({ variants: [{ weight: '0.00', height: '0.00', width: '0.00', depth: '0.00' }] }))).assumed, true);
  assert.deepEqual(tnDimensions(null), { weight: 0, height: 0, width: 0, depth: 0 });
});

test('categorias genericas: "Otros" no se usa para publicar', async () => {
  const { isGenericCategory, pickPrediction, summarizeAudit } = await import('../src/mercadolibre/massPure.js');
  assert.equal(isGenericCategory('Juegos y Juguetes > Otros'), true);
  assert.equal(isGenericCategory('Juegos y Juguetes > Arte y Manualidades > Otros'), true);
  assert.equal(isGenericCategory('Otras'), true);
  assert.equal(isGenericCategory('Juegos y Juguetes > Vehículos de Juguete > Autos'), false);
  assert.equal(isGenericCategory('Juegos y Juguetes > Otros Juegos de Mesa'), true); // ultimo tramo empieza con "Otros"
  assert.equal(isGenericCategory(null), false);
  const preds = [{ categoryId: 'MLA1910', categoryName: 'Otros' }, { categoryId: 'MLA3655', categoryName: 'Autos de Juguete' }];
  assert.equal(pickPrediction(preds)?.categoryId, 'MLA3655');
  assert.equal(pickPrediction([{ categoryId: 'MLA1910', categoryName: 'Otros' }])?.categoryId, 'MLA1910'); // si solo hay generica, esa
  assert.equal(pickPrediction([]), null);

  const row = (o: any) => ({ itemId: 'i', productId: 'p', name: 'n', code: 'c', status: 'active', subStatus: [], finalized: false, categoryId: 'A', categoryName: 'X > Autos', genericCategory: false, shippingMode: 'me2', logisticType: 'drop_off', freeShipping: false, localPickUp: true, pictures: 1, attributes: 4, price: 1, qty: 1, listingType: 'gold_special', catalogListing: false, health: null, permalink: null, titleLength: 30, tags: [], ...o });
  const s = summarizeAudit([
    row({}),
    row({ categoryId: 'G', categoryName: 'X > Otros', genericCategory: true }),
    row({ status: 'under_review', subStatus: ['forbidden'], finalized: true, categoryId: 'G', categoryName: 'X > Otros', genericCategory: true }),
    row({ status: 'paused', subStatus: ['picture_download_pending'], pictures: 4 }),
  ]);
  assert.equal(s.total, 4); assert.equal(s.finalized, 1); assert.equal(s.finalizedGeneric, 1);
  assert.equal(s.live, 3); assert.equal(s.liveInGeneric, 1); assert.equal(s.picturePending, 1);
  assert.deepEqual(s.pictures, { one: 2, twoOrThree: 0, fourPlus: 1, none: 0 });
  assert.equal(s.finalizedByCategory[0].categoryId, 'G');
});

test('arreglos: que publicaciones entran en cada accion y que datos faltan para cambiar de categoria', async () => {
  const { repairTargets, missingForCategory, mlErrorText } = await import('../src/mercadolibre/repairPure.js');
  const row = (o: any) => ({ itemId: 'i', productId: 'p', name: 'n', code: 'c', status: 'active', subStatus: [], finalized: false, categoryId: 'A', categoryName: 'X > Autos', genericCategory: false, shippingMode: 'me2', logisticType: 'drop_off', freeShipping: false, localPickUp: true, pictures: 1, attributes: 4, price: 1, qty: 1, listingType: 'gold_special', catalogListing: false, health: null, permalink: null, titleLength: 30, tags: [], ...o });
  const rows = [
    row({ itemId: 'ok' }),
    row({ itemId: 'otros', genericCategory: true }),
    row({ itemId: 'otrosPausada', status: 'paused', subStatus: ['picture_download_pending'], genericCategory: true }),
    row({ itemId: 'pausada', status: 'paused', subStatus: ['picture_download_pending'] }),
    row({ itemId: 'pausadaPorMi', status: 'paused', subStatus: [] }),
    row({ itemId: 'baja', status: 'under_review', subStatus: ['forbidden'], finalized: true, genericCategory: true }),
    row({ itemId: 'parche', status: 'under_review', subStatus: ['waiting_for_patch'], genericCategory: true }),
  ];
  assert.deepEqual(repairTargets(rows, 'reactivate').map((r) => r.itemId), ['otrosPausada', 'pausada']); // no las que pauso el dueño
  assert.deepEqual(repairTargets(rows, 'recategorize').map((r) => r.itemId), ['otros', 'otrosPausada']); // ni las dadas de baja ni en revision
  assert.deepEqual(repairTargets(rows, 'republish').map((r) => r.itemId), ['baja']);

  const schema = [
    { id: 'BRAND', name: 'Marca', value_type: 'string', tags: { required: true }, values: [{ id: '1', name: 'Mattel' }] },
    { id: 'MODEL', name: 'Modelo', value_type: 'string', tags: { catalog_required: true } },
    { id: 'GENDER', name: 'Género', value_type: 'list', tags: { required: true }, values: [{ id: '1', name: 'Niñas' }] },
    { id: 'COLOR', name: 'Color', value_type: 'string', tags: {} }, // opcional: no cuenta
    { id: 'SELLER_PACKAGE_WEIGHT', name: 'Peso', value_type: 'number_unit', tags: { required: true }, allowed_units: [{ id: 'g' }] },
    { id: 'GTIN', name: 'Código', value_type: 'string', tags: { required: true } },
  ];
  // La publicacion ya tiene genero: se completa marca (del producto) y modelo (con el nombre).
  const a = missingForCategory(schema, [{ id: 'GENDER', value_name: 'Niñas' }], { title: 'Auto rojo', brand: 'Mattel' });
  assert.deepEqual(a.fill, [{ id: 'BRAND', value_name: 'Mattel' }, { id: 'MODEL', value_name: 'Auto rojo' }]);
  assert.deepEqual(a.blocking, []);
  // Sin genero y sin marca: no se puede pasar sola.
  const b = missingForCategory(schema, [{ id: 'GENDER', value_name: null }], { title: 'Auto rojo', brand: null });
  assert.deepEqual(b.blocking, ['Marca', 'Género']);
  assert.deepEqual(missingForCategory(null, null, { title: 'x' }), { fill: [], blocking: [] });

  assert.equal(mlErrorText({ response: { status: 400, data: { message: 'Validation error', cause: [{ type: 'warning', message: 'aviso' }, { type: 'error', message: 'Category is not modifiable' }] } } }), 'Category is not modifiable (400)');
  assert.equal(mlErrorText({ response: { status: 403, data: { message: 'forbidden' } } }), 'forbidden (403)');
  assert.equal(mlErrorText(new Error('timeout')), 'timeout');
});

// Modelo de lo que cobra ML medido el 2026-11-24: 13,5% + fijo por tramos; desde $33.000 no hay
// fijo pero el envio gratis ($8.091) corre por cuenta del vendedor.
const TH = 33000;
const fakeQuote = async (p: number): Promise<FeeQuote> => {
  const applies = p >= TH;
  const fixedFee = applies ? 0 : p < 15000 ? 1330 : p < 25000 ? 2740 : 3320;
  return { saleFee: Math.round((0.135 * p + fixedFee) * 100) / 100, fixedFee, shipping: applies ? 8091 : null, applies };
};
const solve = (target: number) => solveTargetPrice({ target, quote: fakeQuote, threshold: TH, capRatio: 0.9 });

test('precio objetivo: en ML queda lo mismo que en el local', async () => {
  // Hot Wheels $7.200 → (7.200 + 1.330) / 0,865 = 9.861 → $9.870
  const a = await solve(7200);
  assert.equal(a.price, 9870); assert.ok(a.net >= 7200 && a.net < 7215); assert.equal(a.freeShipping, false); assert.equal(a.capped, false);
  // cruza de tramo de costo fijo: $12.500 → con fijo 1.330 daria 15.990, que ya paga fijo 2.740
  const b = await solve(12500);
  assert.ok(b.price >= 15000); assert.ok(b.net >= 12500 - 0.5); assert.ok(b.net < 12500 + 12);
  assert.equal((await fakeQuote(b.price)).fixedFee, 2740);
  // siempre multiplo de 10 y nunca por debajo del objetivo
  for (const t of [5000, 9990, 14000, 18500, 21600]) {
    const r = await solve(t);
    assert.equal(r.price % 10, 0);
    assert.ok(netOf(r.price, await fakeQuote(r.price)) >= t - 0.5, `objetivo ${t}`);
  }
});

test('precio objetivo: cerca del monto de envio gratis se queda justo debajo', async () => {
  // $27.000: para que quede todo habria que ir a ~$40.570 pagando el envio; a $32.990 queda
  // 25.216 (93% de lo del local) → se prefiere quedar debajo
  const r = await solve(27000);
  assert.equal(r.price, 32990); assert.equal(r.capped, true); assert.equal(r.freeShipping, false);
  assert.ok(r.net >= 0.9 * 27000 && r.net < 27000);
});

test('precio objetivo: lejos del limite se cubre el envio en el precio', async () => {
  // $34.000: debajo del limite quedaria 74% → no conviene; (34.000 + 8.091) / 0,865 = 48.660
  const r = await solve(34000);
  assert.equal(r.capped, false); assert.equal(r.freeShipping, true);
  assert.equal(r.price, 48670); assert.ok(r.net >= 34000 && r.net < 34015);
  // sin monto detectado no se hace el recorte, pero el precio cierra igual
  const n = await solveTargetPrice({ target: 27000, quote: fakeQuote, threshold: null });
  assert.equal(n.capped, false); assert.ok(n.net >= 27000 - 0.5);
});

test('ganancia ML: el envio gratis corre por cuenta del vendedor solo donde ML lo exige', () => {
  // datos reales del 2026-11-24: por debajo del monto ML cobra costo fijo y el envio lo paga el comprador
  assert.equal(freeShippingApplies({ mlPrice: 29910, saleFee: 7357.85, fixedFee: 3320, shipping: 8990 }), false);
  // por encima no cobra fijo pero el envio gratis es obligatorio
  assert.equal(freeShippingApplies({ mlPrice: 34850, saleFee: 5053.25, fixedFee: 0, shipping: 8091 }), true);
  // producto casi regalado: fijo en 0 pero no hay envio gratis obligatorio
  assert.equal(freeShippingApplies({ mlPrice: 22, saleFee: 3.3, fixedFee: 0, shipping: 8990 }), false);
  assert.equal(freeShippingApplies({ mlPrice: 40000, saleFee: 5800, fixedFee: 0, shipping: null }), false);

  const abajo = mlProfit({ storePrice: 29910, cost: 16619.4, mlPrice: 29910, saleFee: 7357.85, fixedFee: 3320, shipping: 8990, freeShippingApplies: false });
  assert.equal(abajo.realProfit, abajo.profit); assert.equal(abajo.equalMarkupRealPct, abajo.equalMarkupPct);
  const arriba = mlProfit({ storePrice: 34850, cost: 17000, mlPrice: 34850, saleFee: 5053.25, fixedFee: 0, shipping: 8091, freeShippingApplies: true });
  assert.equal(arriba.realProfit, 4705.75); assert.equal(arriba.realProfit, arriba.profitFreeShipping);
  assert.equal(arriba.equalMarkupRealPct, arriba.equalMarkupFreeShippingPct);
});

test('ganancia ML: comision + costo fijo, con y sin envio a cargo, y recargo para igualar al local', () => {
  // costo 6.000, precio 10.000 → en el local gana 4.000 (40%)
  // ML: 13% (1.300) + fijo 200 = 1.500 → gana 2.500 (25%); con envio de 3.000 pierde 500
  const r = mlProfit({ storePrice: 10000, cost: 6000, mlPrice: 10000, saleFee: 1500, fixedFee: 200, shipping: 3000 });
  assert.equal(r.storeProfit, 4000); assert.equal(r.storeMarginPct, 40);
  assert.equal(r.profit, 2500); assert.equal(r.marginPct, 25); assert.equal(r.feePct, 13);
  assert.equal(r.profitFreeShipping, -500); assert.equal(r.marginFreeShippingPct, -5);
  // para ganar 4.000: p − 0,13p − 200 − 6.000 = 4.000 → p = 11.724,14 → +17,24%
  assert.equal(r.equalMarkupPct, 17.24);
  // con el envio: p = (4.000 + 6.000 + 200 + 3.000) / 0,87 = 15.172,41 → +51,72%
  assert.equal(r.equalMarkupFreeShippingPct, 51.72);
  // comprobacion: a ese precio la ganancia iguala a la del local
  const p = 10000 * (1 + r.equalMarkupPct! / 100);
  assert.ok(Math.abs((p - (0.13 * p + 200) - 6000) - 4000) < 1);
});

test('ganancia ML: sin cotizacion de envio no inventa ese escenario', () => {
  const r = mlProfit({ storePrice: 5000, cost: 2000, mlPrice: 5500, saleFee: 715, fixedFee: 0, shipping: null });
  assert.equal(r.shipping, null); assert.equal(r.profitFreeShipping, null); assert.equal(r.equalMarkupFreeShippingPct, null);
  assert.equal(r.profit, 2785);
  assert.equal(mlProfit({ storePrice: 5000, cost: 2000, mlPrice: 5000, saleFee: 650, shipping: 0 }).shipping, null);
});

test('ganancia ML: lee listing_prices venga como objeto, lista o lista de listas', () => {
  const clasica = { listing_type_id: 'gold_special', sale_fee_amount: 887.7 };
  const premium = { listing_type_id: 'gold_pro', sale_fee_amount: 2000 };
  assert.equal(pickListingPrice(clasica, 'gold_special'), clasica);
  assert.equal(pickListingPrice([premium, clasica], 'gold_special'), clasica);
  assert.equal(pickListingPrice([[premium, clasica]], 'gold_special'), clasica);
  assert.equal(pickListingPrice([premium], 'gold_special'), premium); // unica opcion devuelta
  assert.equal(pickListingPrice([], 'gold_special'), null);
});

const mv = (o: Partial<MassVariant> & { id: string }): MassVariant => ({ value: '', stock: 0, linked: false, price: 1000, hasGtin: true, ...o });
const mp = (o: Partial<MassProduct> & { variants: MassVariant[] }): MassProduct => ({ id: 'p', name: 'Producto', code: 'C1', hasPicture: true, productLinked: false, ...o });
const NONE = { product: false, variantIds: new Set<string>() };

test('masivo: producto simple con stock y foto queda listo con una publicacion', () => {
  const v = classifyForMl(mp({ variants: [mv({ id: 'v1', stock: 3, isDefault: true })] }), NONE);
  assert.deepEqual(v, { status: 'ready', listings: 1, variantIds: ['v1'], stock: 3, noGtin: false });
});

test('masivo: sin stock, ya vinculado, sin foto y sin precio no se publican', () => {
  assert.equal(classifyForMl(mp({ variants: [mv({ id: 'v1', stock: 0, isDefault: true })] }), NONE).status, 'no_stock');
  assert.equal(classifyForMl(mp({ productLinked: true, variants: [mv({ id: 'v1', stock: 5, isDefault: true })] }), NONE).status, 'linked');
  assert.equal(classifyForMl(mp({ variants: [mv({ id: 'v1', stock: 5, linked: true, isDefault: true })] }), NONE).status, 'linked');
  assert.equal(classifyForMl(mp({ hasPicture: false, variants: [mv({ id: 'v1', stock: 5, isDefault: true })] }), NONE).status, 'no_picture');
  assert.equal(classifyForMl(mp({ variants: [mv({ id: 'v1', stock: 5, price: 0, isDefault: true })] }), NONE).status, 'no_price');
});

test('masivo: lo que ya esta en ML sin vincular no se publica (evita duplicados)', () => {
  const p = mp({ variants: [mv({ id: 'v1', stock: 5, isDefault: true })] });
  assert.equal(classifyForMl(p, { product: true, variantIds: new Set() }).status, 'on_ml');
  assert.equal(classifyForMl(p, { product: false, variantIds: new Set(['v1']) }).status, 'on_ml');
});

test('masivo: con variantes sale una publicacion por variante con stock y sin vincular', () => {
  const p = mp({ variants: [
    mv({ id: 'r', value: 'Rojo', stock: 2 }),
    mv({ id: 'a', value: 'Azul', stock: 0 }),            // sin stock: no se publica
    mv({ id: 'v', value: 'Verde', stock: 4, linked: true }), // ya publicada
    mv({ id: 'n', value: 'Negro', stock: 1, hasGtin: false }),
  ] });
  assert.equal(isFanOut(p.variants), true);
  assert.deepEqual(classifyForMl(p, NONE), { status: 'ready', listings: 2, variantIds: ['r', 'n'], stock: 3, noGtin: true });
  // producto ya vinculado pero con variantes nuevas: se completan las que faltan
  assert.equal(classifyForMl({ ...p, productLinked: true }, NONE).status, 'ready');
  // todas las que tienen stock ya estan publicadas
  const done = mp({ productLinked: true, variants: [mv({ id: 'r', value: 'Rojo', stock: 2, linked: true }), mv({ id: 'a', value: 'Azul', stock: 0 })] });
  assert.equal(classifyForMl(done, NONE).status, 'linked');
  // una variante a publicar ya existe en ML sin vincular
  assert.equal(classifyForMl(p, { product: false, variantIds: new Set(['n']) }).status, 'on_ml');
});

test('masivo: variantes sin valor distintivo = publicacion simple con el stock de la principal', () => {
  const p = mp({ variants: [mv({ id: 'd', stock: 0, isDefault: true }), mv({ id: 'x', stock: 9 })] });
  assert.equal(isFanOut(p.variants), false);
  assert.equal(classifyForMl(p, NONE).status, 'no_stock');
});

test('masivo: recargo de precio y motivos de rechazo', () => {
  assert.equal(priceWithFactor(10000, 1.15), 11500);
  assert.equal(priceWithFactor(9999, 1.1), 10999);
  assert.equal(priceWithFactor(10000, 1), 10000);
  assert.equal(priceWithFactor(10000, undefined), 10000);
  assert.equal(publishFailureReason({ error: 'no_picture' }), 'Sin foto');
  assert.match(publishFailureReason({ error: 'missing_attributes', missing: [{ id: 'GENDER', name: 'Género' }] }), /Género/);
  assert.match(publishFailureReason({ error: 'ml_rejected', details: { message: 'Validation error', cause: [{ type: 'warning', message: 'aviso' }, { type: 'error', message: 'El GTIN es obligatorio' }] } }), /GTIN es obligatorio/);
  assert.doesNotMatch(publishFailureReason({ error: 'ml_rejected', details: { cause: [{ type: 'warning', message: 'aviso' }, { type: 'error', message: 'X' }] } }), /aviso/);
  assert.equal(isHardStop({ error: 'ml_rejected', details: { status: 429, message: 'too many' } }), true);
  assert.equal(isHardStop({ error: 'ml_rejected', details: { status: 400 } }), false);
  assert.equal(isHardStop({ error: 'no_picture' }), false);
});

test('Flex: arma el horario por dia y marca los dias que no se despacha', () => {
  const s = flexSchedule({ week: [{ capacity: 500, from: 12, to: 21, cutoff: 14 }], saturday: [{ capacity: 100, from: 12, to: 18, cutoff: 12 }], sunday: [] });
  assert.deepEqual(s[0], { day: 'week', label: 'Lunes a viernes', works: true, ranges: [{ from: 12, to: 21, cutoff: 14, capacity: 500 }] });
  assert.equal(s[1].ranges[0].cutoff, 12);
  assert.deepEqual(s[2], { day: 'sunday', label: 'Domingos', works: false, ranges: [] });
  // sin dato de corte (corte por zona) no inventa una hora
  assert.equal(flexSchedule({ week: [{ from: 9, to: 21 }] })[0].ranges[0].cutoff, null);
  assert.equal(flexSchedule(null).every((d) => !d.works), true);
});
import { sumPendingForVariant, isHistoricalOrder, isBeforeCutoff, orderPaidAt } from '../src/services/pendingMath.js';

test('corte "empezar desde ahora": solo entra lo pagado después del corte', () => {
  const corte = new Date('2026-11-20T18:00:00.000Z');
  // pagada antes del corte → no entra
  assert.equal(isBeforeCutoff(orderPaidAt({ date_created: '2026-11-20T10:00:00.000-04:00', date_closed: '2026-11-20T10:01:00.000-04:00' }), corte), true);
  // pagada después → entra
  assert.equal(isBeforeCutoff(orderPaidAt({ date_created: '2026-11-20T15:00:00.000-04:00', date_closed: '2026-11-20T15:00:30.000-04:00' }), corte), false);
  // comprada antes pero pagada después (pago en efectivo que tarda) → es venta nueva, entra
  assert.equal(isBeforeCutoff(orderPaidAt({ date_created: '2026-11-19T10:00:00.000-04:00', date_closed: '2026-11-21T09:00:00.000-04:00' }), corte), false);
  // sin date_closed se usa la fecha de compra
  assert.equal(isBeforeCutoff(orderPaidAt({ date_created: '2026-11-19T10:00:00.000-04:00' }), corte), true);
  // sin corte o sin fecha válida → entra
  assert.equal(isBeforeCutoff('2026-01-01T00:00:00Z', null), false);
  assert.equal(isBeforeCutoff(orderPaidAt(null), corte), false);
  assert.equal(isBeforeCutoff('no-es-fecha', corte), false);
});

const listing = (o: Partial<MlListing> & { id: string; title: string }): MlListing => ({
  permalink: null, status: 'active', qty: 5, skus: [], variations: [], ...o,
});

const mochila: InvProduct = {
  id: 'p1', name: 'Mochila Espalda 16" Frozen', code: 'SKU-1',
  variants: [{ id: 'v1', name: 'default', barcode: '7791234567890', code: 'MOCH-FRZ', attributes: {}, isDefault: true }],
};
const lunchera: InvProduct = {
  id: 'p2', name: 'Lunchera Térmica Spiderman', code: 'LUN-SPD',
  variants: [{ id: 'v2', name: 'default', barcode: null, code: null, attributes: {}, isDefault: true }],
};
const remera: InvProduct = {
  id: 'p3', name: 'Mochila Carro Cresko', code: 'CRK',
  variants: [
    { id: 'v3r', name: 'Rojo', barcode: 'CRK-R', code: null, attributes: { Color: 'Rojo' } },
    { id: 'v3a', name: 'Azul', barcode: 'CRK-A', code: null, attributes: { Color: 'Azul' } },
    { id: 'v3s', name: 'Rosa', barcode: null, code: null, attributes: { Color: 'Rosa' } },
  ],
};
const products = [mochila, lunchera, remera];

test('normalización de códigos y títulos', () => {
  assert.equal(normSku(' moch-frz '), 'MOCH-FRZ');
  assert.equal(normTitle('Lunchera  Térmica — SPIDERMAN!'), 'lunchera termica spiderman');
});

test('empareja por código de barras (GTIN/SKU)', () => {
  const rows = matchListings([listing({ id: 'MLA1', title: 'Cualquier titulo', skus: ['7791234567890'] })], products, []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'match');
  assert.equal(rows[0].by, 'sku');
  assert.equal(rows[0].variantId, 'v1');
});

test('empareja por código del producto cuando tiene una sola variante', () => {
  const rows = matchListings([listing({ id: 'MLA2', title: 'x', skus: ['lun-spd'] })], products, []);
  assert.equal(rows[0].state, 'match');
  assert.equal(rows[0].variantId, 'v2');
});

test('empareja por título exacto (ignora acentos, mayúsculas y símbolos)', () => {
  const rows = matchListings([listing({ id: 'MLA3', title: 'LUNCHERA TERMICA SPIDERMAN' })], products, []);
  assert.equal(rows[0].state, 'match');
  assert.equal(rows[0].by, 'title');
  assert.equal(rows[0].variantId, 'v2');
});

test('título parecido pero distinto NO se empareja', () => {
  const rows = matchListings([listing({ id: 'MLA4', title: 'Lunchera Termica Spiderman 2 Pisos' })], products, []);
  assert.equal(rows[0].state, 'unmatched');
});

test('publicación con variaciones: cada variación a su variante (por código y por color)', () => {
  const rows = matchListings([listing({
    id: 'MLA5', title: 'Mochila Carro Cresko',
    variations: [
      { id: '100', skus: ['CRK-R'], values: ['Rojo'], qty: 2 },
      { id: '200', skus: [], values: ['Azul'], qty: 3 },
      { id: '300', skus: [], values: ['Verde'], qty: 1 },
    ],
  })], products, []);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.state), ['match', 'match', 'unmatched']);
  assert.equal(rows[0].variantId, 'v3r'); assert.equal(rows[0].by, 'sku'); assert.equal(rows[0].mlVariationId, '100');
  assert.equal(rows[1].variantId, 'v3a'); assert.equal(rows[1].by, 'title');
  assert.equal(rows[2].suggestedProductId, 'p3');
});

test('valor de variación por palabra completa: "S" no matchea "Rosa"', () => {
  const rows = matchListings([listing({
    id: 'MLA6', title: 'Mochila Carro Cresko', variations: [{ id: '1', skus: [], values: ['S'], qty: 1 }],
  })], products, []);
  assert.equal(rows[0].state, 'unmatched');
});

test('una publicación por variante (fan-out): título = nombre + valor', () => {
  const rows = matchListings([listing({ id: 'MLA7', title: 'Mochila Carro Cresko Rosa' })], products, []);
  assert.equal(rows[0].state, 'match');
  assert.equal(rows[0].variantId, 'v3s');
});

test('publicación simple de un producto con varias variantes queda para elegir a mano', () => {
  const rows = matchListings([listing({ id: 'MLA8', title: 'Mochila Carro Cresko' })], products, []);
  assert.equal(rows[0].state, 'unmatched');
  assert.equal(rows[0].suggestedProductId, 'p3');
  assert.match(rows[0].note ?? '', /varias variantes/);
});

test('lo ya vinculado se informa como vinculado y no se vuelve a proponer', () => {
  const rows = matchListings(
    [listing({ id: 'MLA1', title: 'x', skus: ['7791234567890'] })],
    products,
    [{ variantId: 'v1', mlItemId: 'MLA1', mlVariationId: null }],
  );
  assert.equal(rows[0].state, 'linked');
  assert.equal(rows[0].variantId, 'v1');
});

test('no pisa un vínculo existente ni asigna la misma variante a dos publicaciones', () => {
  // v1 ya está vinculada a MLA1 → otra publicación con el mismo código no la toma
  const a = matchListings(
    [listing({ id: 'MLA9', title: 'x', skus: ['7791234567890'] })],
    products,
    [{ variantId: 'v1', mlItemId: 'MLA1', mlVariationId: null }],
  );
  assert.equal(a[0].state, 'unmatched');
  assert.match(a[0].note ?? '', /ya está vinculado/);

  // dos publicaciones duplicadas del mismo producto → solo la primera se propone
  const b = matchListings(
    [listing({ id: 'MLA10', title: 'Lunchera Termica Spiderman' }), listing({ id: 'MLA11', title: 'Lunchera Térmica Spiderman' })],
    products, [],
  );
  assert.deepEqual(b.map((r) => r.state), ['match', 'unmatched']);
  assert.match(b[1].note ?? '', /duplicada/);
});

test('código ambiguo (dos variantes con el mismo código) no se usa', () => {
  const dup: InvProduct[] = [
    { id: 'a', name: 'A', variants: [{ id: 'va', barcode: 'X1' }] },
    { id: 'b', name: 'B', variants: [{ id: 'vb', code: 'x1' }] },
  ];
  const rows = matchListings([listing({ id: 'MLA12', title: 'zzz', skus: ['X1'] })], dup, []);
  assert.equal(rows[0].state, 'unmatched');
});

// ---------- Reserva de ventas online pendientes ----------

test('reserva ML: publicación simple suma las unidades pendientes de ese item', () => {
  const n = sumPendingForVariant({
    ml: { mlItemId: 'MLA1', mlVariationId: null, otherVariationIds: [] },
    mlOrders: [
      { items: [{ mlItemId: 'MLA1', mlVariationId: null, qty: 2 }, { mlItemId: 'MLA2', qty: 5 }] },
      { items: [{ mlItemId: 'MLA1', qty: 1 }] },
    ],
  });
  assert.equal(n, 3);
});

test('reserva ML: con variaciones solo cuenta la variación de esa variante', () => {
  const orders = [{ items: [{ mlItemId: 'MLA5', mlVariationId: 100, qty: 1 }, { mlItemId: 'MLA5', mlVariationId: '200', qty: 4 }] }];
  assert.equal(sumPendingForVariant({ ml: { mlItemId: 'MLA5', mlVariationId: '100', otherVariationIds: ['200'] }, mlOrders: orders }), 1);
  assert.equal(sumPendingForVariant({ ml: { mlItemId: 'MLA5', mlVariationId: '200', otherVariationIds: ['100'] }, mlOrders: orders }), 4);
});

test('reserva ML: mapeo a nivel item no cuenta variaciones que son de otra variante', () => {
  const n = sumPendingForVariant({
    ml: { mlItemId: 'MLA5', mlVariationId: null, otherVariationIds: ['200'] },
    mlOrders: [{ items: [{ mlItemId: 'MLA5', mlVariationId: '200', qty: 4 }, { mlItemId: 'MLA5', mlVariationId: '999', qty: 1 }] }],
  });
  assert.equal(n, 1);
});

test('reserva TN + ML se suman; sin mapeos ni órdenes da 0', () => {
  const n = sumPendingForVariant({
    ml: { mlItemId: 'MLA1', mlVariationId: null, otherVariationIds: [] },
    mlOrders: [{ items: [{ mlItemId: 'MLA1', qty: 1 }] }],
    tnVariantId: '555',
    tnOrders: [{ items: [{ tnVariantId: '555', qty: 2 }, { tnVariantId: '777', qty: 9 }] }],
  });
  assert.equal(n, 3);
  assert.equal(sumPendingForVariant({}), 0);
  assert.equal(sumPendingForVariant({ ml: null, tnVariantId: null, mlOrders: [{ items: [{ mlItemId: 'MLA1', qty: 3 }] }] }), 0);
});

test('reserva: cantidades inválidas o negativas no rompen ni restan', () => {
  const n = sumPendingForVariant({
    ml: { mlItemId: 'MLA1', mlVariationId: null, otherVariationIds: [] },
    mlOrders: [{ items: [{ mlItemId: 'MLA1', qty: -2 }, { mlItemId: 'MLA1', qty: Number.NaN }, { mlItemId: 'MLA1', qty: 2 }] }, { items: null as any }],
  });
  assert.equal(n, 2);
});

test('historial: compra anterior a la conexión de la cuenta no entra como pendiente', () => {
  const connectedAt = new Date('2026-11-01T21:00:00Z');
  assert.equal(isHistoricalOrder('2026-02-10T14:22:11.000-04:00', connectedAt), true);
  assert.equal(isHistoricalOrder('2026-11-03T10:00:00.000-04:00', connectedAt), false);
  // el mismo día de la conexión queda dentro del margen (no se pierde una venta real)
  assert.equal(isHistoricalOrder('2026-11-01T09:00:00.000-04:00', connectedAt), false);
  assert.equal(isHistoricalOrder(null, connectedAt), false);
  assert.equal(isHistoricalOrder('2026-02-10T00:00:00Z', null), false);
  assert.equal(isHistoricalOrder('no-es-fecha', connectedAt), false);
});

test('preguntas ML: normaliza la pregunta y descarta las eliminadas', () => {
  const q = normalizeQuestion({ id: 13001, text: 'Hola, tienen stock?', status: 'UNANSWERED', item_id: 'MLA123', date_created: '2026-11-20T10:00:00.000-04:00', from: { id: 555 }, answer: null });
  assert.deepEqual(q, { id: '13001', text: 'Hola, tienen stock?', status: 'UNANSWERED', dateCreated: '2026-11-20T10:00:00.000-04:00', itemId: 'MLA123', buyerId: '555', answer: null });
  const a = normalizeQuestion({ id: 2, text: 'x', status: 'ANSWERED', item_id: 'MLA1', answer: { text: 'Si, hay', status: 'ACTIVE', date_created: '2026-11-20T11:00:00.000-04:00' } });
  assert.deepEqual(a?.answer, { text: 'Si, hay', dateCreated: '2026-11-20T11:00:00.000-04:00' });
  assert.equal(normalizeQuestion({ id: 3, text: 'spam', status: 'BANNED' }), null);
  assert.equal(normalizeQuestion({ id: 4, text: 'x', status: 'UNANSWERED', deleted_from_listing: true }), null);
  assert.equal(normalizeQuestion({ text: 'sin id' }), null);
  assert.equal(normalizeQuestion(null), null);
});

test('preguntas ML: la respuesta se limpia y se valida antes de publicarla', () => {
  assert.equal(cleanAnswerText('  Hola! Si, tenemos stock.  \r\nSaludos   \n'), 'Hola! Si, tenemos stock.\nSaludos');
  assert.throws(() => cleanAnswerText('   \n '), /Escrib/);
  assert.throws(() => cleanAnswerText(null), /Escrib/);
  assert.equal(cleanAnswerText('a'.repeat(ANSWER_MAX_CHARS)).length, ANSWER_MAX_CHARS);
  assert.throws(() => cleanAnswerText('a'.repeat(ANSWER_MAX_CHARS + 1)), /muy larga/);
});
