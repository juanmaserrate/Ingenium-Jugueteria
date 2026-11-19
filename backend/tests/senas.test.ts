// Pruebas de la lógica pura de señas. Correr: npm test (desde backend/)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { senaLeftover, allocateSenas } from '../src/services/senaMath.js';

test('seña igual o menor que la venta: no sobra nada', () => {
  assert.equal(senaLeftover(20000, 20000), 0);
  assert.deepEqual(allocateSenas(50000, [20000]), [{ applied: 20000, leftover: 0 }]);
});

test('seña mayor que la venta: se aplica el total y sobra la diferencia', () => {
  assert.equal(senaLeftover(20000, 15000), 5000);
  assert.deepEqual(allocateSenas(15000, [20000]), [{ applied: 15000, leftover: 5000 }]);
});

test('dos señas: la primera cubre lo que puede y la segunda el resto', () => {
  assert.deepEqual(allocateSenas(25000, [20000, 10000]), [
    { applied: 20000, leftover: 0 },
    { applied: 5000, leftover: 5000 },
  ]);
});

test('con un vale aplicado antes, la seña solo cubre lo que queda', () => {
  assert.deepEqual(allocateSenas(30000, [20000], 15000), [{ applied: 15000, leftover: 5000 }]);
});

test('venta ya cubierta: la seña sobra entera', () => {
  assert.deepEqual(allocateSenas(10000, [8000], 10000), [{ applied: 0, leftover: 8000 }]);
});

test('centavos: no inventa sobrantes por coma flotante', () => {
  assert.equal(senaLeftover(0.3, 0.1 + 0.2), 0);
  assert.deepEqual(allocateSenas(1999.99, [2000]), [{ applied: 1999.99, leftover: 0 }]);
  assert.equal(senaLeftover(2000, 1999.5), 0.5);
});
