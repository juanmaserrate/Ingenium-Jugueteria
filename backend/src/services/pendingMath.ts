// Cálculo PURO (sin base) de unidades comprometidas por ventas online pendientes.
// Separado de pendingReserve.ts para poder testearlo: ver backend/tests/pending.test.ts.

export type MlPendingItem = { mlItemId?: string | null; mlVariationId?: string | number | null; qty?: number };
export type TnPendingItem = { tnVariantId?: string | null; qty?: number };

// PURA (testeable): unidades comprometidas de UNA variante.
//  - ml: el mapeo de la variante + las variaciones del mismo item mapeadas a OTRAS variantes
//    (para no contar de más cuando la orden trae una variación que es de otra variante).
export function sumPendingForVariant(input: {
  ml?: { mlItemId: string; mlVariationId: string | null; otherVariationIds: string[] } | null;
  mlOrders?: Array<{ items: MlPendingItem[] }>;
  tnVariantId?: string | null;
  tnOrders?: Array<{ items: TnPendingItem[] }>;
}): number {
  let total = 0;
  const q = (n: unknown) => Math.max(0, Math.round(Number(n) || 0));

  if (input.ml) {
    const { mlItemId, mlVariationId, otherVariationIds } = input.ml;
    const others = new Set(otherVariationIds.map(String));
    for (const o of input.mlOrders ?? []) {
      for (const it of Array.isArray(o.items) ? o.items : []) {
        if (String(it.mlItemId ?? '') !== mlItemId) continue;
        const itVar = it.mlVariationId != null && it.mlVariationId !== '' ? String(it.mlVariationId) : null;
        if (mlVariationId) {
          if (itVar === mlVariationId) total += q(it.qty);
        } else if (!itVar || !others.has(itVar)) {
          // mapeo a nivel item: toma todo lo del item que no sea de una variación de otra variante
          total += q(it.qty);
        }
      }
    }
  }

  if (input.tnVariantId) {
    const tnVar = String(input.tnVariantId);
    for (const o of input.tnOrders ?? []) {
      for (const it of Array.isArray(o.items) ? o.items : []) {
        if (String(it.tnVariantId ?? '') === tnVar) total += q(it.qty);
      }
    }
  }
  return total;
}
