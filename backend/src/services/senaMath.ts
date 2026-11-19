// Cálculos PUROS de señas (sin base), testeables: ver backend/tests/senas.test.ts.

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// Cuánto sobra al usar una seña de `senaAmount` para cubrir `applied` (0 si no sobra).
export function senaLeftover(senaAmount: number, applied: number): number {
  const left = round2(Number(senaAmount) - Number(applied));
  return left > 0.01 ? left : 0;
}

// Reparte las señas elegidas contra el total de la venta, en orden: cada una cubre lo que
// falta y lo que no se usa queda como sobrante a devolver. `fixedOther` = lo ya cubierto por
// otros pagos fijos (vales).
export function allocateSenas(total: number, senaAmounts: number[], fixedOther = 0): Array<{ applied: number; leftover: number }> {
  let remaining = Math.max(0, round2(Number(total) - Number(fixedOther)));
  return senaAmounts.map((amt) => {
    const a = Math.max(0, Number(amt) || 0);
    const applied = round2(Math.min(a, remaining));
    remaining = round2(remaining - applied);
    return { applied, leftover: senaLeftover(a, applied) };
  });
}
