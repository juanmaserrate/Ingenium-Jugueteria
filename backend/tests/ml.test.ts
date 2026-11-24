// Pruebas de la lógica pura de Mercado Libre (sin base ni red).
// Correr:  npm test   (desde backend/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchListings, normSku, normTitle, type InvProduct, type MlListing } from '../src/mercadolibre/match.js';
import { normalizeQuestion, cleanAnswerText, ANSWER_MAX_CHARS, flexSchedule } from '../src/mercadolibre/questionsPure.js';
import { classifyForMl, isFanOut, priceWithFactor, publishFailureReason, isHardStop, type MassProduct, type MassVariant } from '../src/mercadolibre/massPure.js';

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
