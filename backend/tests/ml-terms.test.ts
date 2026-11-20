// Pruebas de condiciones de venta y mapeo de categorías de Mercado Libre (lógica pura).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeWarrantyTerms, tallyPredictions, pickSpread, tallyListingCategories, isValidGtin, STORE_SALE_TERMS } from '../src/mercadolibre/pure.js';

test('garantía: publicación sin términos recibe garantía del vendedor de 30 días', () => {
  assert.deepEqual(mergeWarrantyTerms([]), STORE_SALE_TERMS);
  assert.deepEqual(mergeWarrantyTerms(null), STORE_SALE_TERMS);
});

test('garantía: si ya tiene 30 días del vendedor no se toca', () => {
  assert.equal(mergeWarrantyTerms([
    { id: 'WARRANTY_TYPE', value_id: '2230280', value_name: 'Garantía del vendedor' },
    { id: 'WARRANTY_TIME', value_name: '30 días' },
  ]), null);
});

test('garantía: reemplaza otra garantía y conserva los demás términos', () => {
  const out = mergeWarrantyTerms([
    { id: 'WARRANTY_TYPE', value_id: '6150835', value_name: 'Sin garantía' },
    { id: 'MANUFACTURING_TIME', value_name: '5 días' },
    { id: 'INVOICE', value_id: '6891885', value_name: 'Factura A' },
  ])!;
  assert.deepEqual(out, [
    { id: 'MANUFACTURING_TIME', value_name: '5 días' },
    { id: 'INVOICE', value_id: '6891885' },
    ...STORE_SALE_TERMS,
  ]);
});

test('garantía: 90 días de fábrica se cambia a 30 del vendedor', () => {
  const out = mergeWarrantyTerms([
    { id: 'WARRANTY_TYPE', value_name: 'Garantía de fábrica' },
    { id: 'WARRANTY_TIME', value_name: '90 días' },
  ])!;
  assert.deepEqual(out, STORE_SALE_TERMS);
});

test('categorías: gana la más votada y se informa qué tan pareja fue', () => {
  const r = tallyPredictions([
    { categoryId: 'MLA1', categoryName: 'Mochilas' }, { categoryId: 'MLA1', categoryName: 'Mochilas' },
    { categoryId: 'MLA2', categoryName: 'Luncheras' }, null, { categoryId: 'MLA1', categoryName: 'Mochilas' },
  ]);
  assert.equal(r.total, 4);
  assert.equal(r.candidates[0].categoryId, 'MLA1');
  assert.equal(r.candidates[0].votes, 3);
  assert.equal(r.candidates[0].share, 0.75);
  assert.equal(r.candidates[1].categoryId, 'MLA2');
});

test('categorías: sin predicciones no propone nada', () => {
  assert.deepEqual(tallyPredictions([null, undefined]), { total: 0, candidates: [] });
});

test('muestra repartida: toma de toda la lista, no solo del principio', () => {
  const list = Array.from({ length: 100 }, (_, i) => i);
  assert.deepEqual(pickSpread(list, 4), [0, 25, 50, 75]);
  assert.deepEqual(pickSpread([1, 2, 3], 12), [1, 2, 3]);
  assert.deepEqual(pickSpread(list, 0), []);
});

test('categorías desde publicaciones reales: cuenta por categoría del sistema', () => {
  const t = tallyListingCategories([
    { systemCategoryId: 'mochilas', mlCategoryId: 'MLA1' }, { systemCategoryId: 'mochilas', mlCategoryId: 'MLA1' },
    { systemCategoryId: 'mochilas', mlCategoryId: 'MLA9' }, { systemCategoryId: 'luncheras', mlCategoryId: 'MLA2' },
    { systemCategoryId: null, mlCategoryId: 'MLA1' }, { systemCategoryId: 'mochilas', mlCategoryId: null },
  ]);
  assert.equal(t.get('mochilas')!.total, 3);
  assert.equal(t.get('mochilas')!.candidates[0].categoryId, 'MLA1');
  assert.equal(Math.round(t.get('mochilas')!.candidates[0].share * 100), 67);
  assert.deepEqual(t.get('luncheras')!.candidates, [{ categoryId: 'MLA2', votes: 1, share: 1 }]);
  assert.equal(t.has('null'), false);
});

test('código de barras: acepta GTIN reales y rechaza códigos internos', () => {
  assert.equal(isValidGtin('7790001000010'), false); // dígito verificador incorrecto
  assert.equal(isValidGtin('7791234567898'), true);  // EAN-13 válido
  assert.equal(isValidGtin('4006381333931'), true);  // EAN-13 válido
  assert.equal(isValidGtin('036000291452'), true);   // UPC-A válido
  assert.equal(isValidGtin('96385074'), true);       // EAN-8 válido
  assert.equal(isValidGtin('SKU-123456'), false);
  assert.equal(isValidGtin('12345'), false);
  assert.equal(isValidGtin(''), false);
  assert.equal(isValidGtin(null), false);
});
