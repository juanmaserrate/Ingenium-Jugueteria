import { prisma } from '../db.js';
import { requireMlClient } from './client.js';
import { predictCategory } from './publish.js';
import { pickSpread } from './pure.js';
import { mlProfit, pickListingPrice, priceWithFactor, freeShippingApplies, packageFor, type MlProfit } from './massPure.js';
import { ValidationError } from '../utils/errors.js';

// Simulador: toma una muestra de productos con stock que NO están en Mercado Libre y, con la
// comisión que informa ML para cada uno (categoría + precio + logística), calcula cuánto queda
// de ganancia. Solo lee: no publica ni modifica nada.

const SITE = 'MLA';
const LISTING = 'gold_special'; // Clásica
const MIN_PRICE = 1000;         // por debajo son datos de carga (precios de prueba, centavos)
export const LOGISTICS = ['drop_off', 'xd_drop_off', 'cross_docking', 'self_service'] as const;

export type ProfitRow = {
  productId: string; code: string; name: string; stock: number;
  cost: number; storePrice: number;
  mlCategoryId: string | null; categorySource: 'mapeada' | 'predicha' | null;
  weightG: number; weightAssumed: boolean;
  result: MlProfit | null;
  error: string | null;
};

export async function profitSample(opts: { n?: number; markupPct?: number; logistic?: string }) {
  const n = Math.min(30, Math.max(1, Math.floor(opts.n ?? 12)));
  const markupPct = Math.min(200, Math.max(0, Number(opts.markupPct) || 0));
  const logistic = (LOGISTICS as readonly string[]).includes(String(opts.logistic)) ? String(opts.logistic) : 'drop_off';
  const ml = await requireMlClient();
  const integ = await prisma.integration.findUnique({ where: { provider: 'mercadolibre' } });
  if (!integ?.mlUserId) throw new ValidationError('Mercado Libre no está conectado');

  // Candidatos: activos, con costo y precio, con stock, sin vínculo con ML.
  const products = await prisma.product.findMany({
    where: {
      active: true, cost: { gt: 0 }, price: { gte: MIN_PRICE }, mlMapping: null,
      variants: { some: { stocks: { some: { qty: { gt: 0 } } } }, every: { mlMapping: null } },
    },
    select: {
      id: true, code: true, name: true, cost: true, price: true, weight: true, width: true, height: true, depth: true,
      category: { select: { mlCategoryId: true } }, subcategory: { select: { mlCategoryId: true } },
      variants: { select: { stocks: { select: { qty: true, reservedQty: true } } } },
    },
    orderBy: { price: 'asc' },
  });
  // Muestra repartida a lo largo de todo el rango de precios (baratos, medios y caros).
  const sample = pickSpread(products, n);

  const rows: ProfitRow[] = [];
  for (const p of sample) {
    const stock = p.variants.reduce((s, v) => s + v.stocks.reduce((a, st) => a + Math.max(0, st.qty - st.reservedQty), 0), 0);
    const pkg = packageFor(p);
    const weightAssumed = pkg.assumed;
    const weightG = pkg.weightG;
    const row: ProfitRow = {
      productId: p.id, code: p.code, name: p.name, stock, cost: p.cost, storePrice: p.price,
      mlCategoryId: null, categorySource: null, weightG, weightAssumed, result: null, error: null,
    };
    rows.push(row);
    try {
      let categoryId = p.subcategory?.mlCategoryId ?? p.category?.mlCategoryId ?? null;
      row.categorySource = categoryId ? 'mapeada' : null;
      if (!categoryId) {
        const preds = await predictCategory(p.name.slice(0, 60));
        categoryId = preds[0]?.categoryId ?? null;
        row.categorySource = categoryId ? 'predicha' : null;
      }
      if (!categoryId) { row.error = 'No se pudo determinar la categoría de Mercado Libre'; continue; }
      row.mlCategoryId = categoryId;

      const mlPrice = priceWithFactor(p.price, 1 + markupPct / 100);
      const lp = await ml.listingPrices(SITE, {
        price: mlPrice, currency_id: 'ARS', category_id: categoryId, listing_type_id: LISTING,
        logistic_type: logistic, shipping_mode: 'me2', billable_weight: weightG,
      });
      const entry = pickListingPrice(lp, LISTING);
      if (!entry || entry.sale_fee_amount == null) { row.error = 'Mercado Libre no informó la comisión'; continue; }

      // Envío gratis a cargo del vendedor (obligatorio desde cierto precio). Es una cotización.
      let shipping: number | null = null;
      try {
        const q: any = await ml.freeShippingQuote(integ.mlUserId, {
          dimensions: `${pkg.heightCm}x${pkg.widthCm}x${pkg.lengthCm},${weightG}`,
          item_price: mlPrice, listing_type_id: LISTING, mode: 'me2', condition: 'new',
          logistic_type: logistic, free_shipping: true, verbose: true,
        });
        const cost = Number(q?.coverage?.all_country?.list_cost);
        shipping = Number.isFinite(cost) && cost > 0 ? cost : null;
      } catch { /* sin cotización: se informa solo la comisión */ }

      const saleFee = Number(entry.sale_fee_amount) || 0;
      const fixedFee = Number(entry.sale_fee_details?.fixed_fee) || 0;
      row.result = mlProfit({
        storePrice: p.price, cost: p.cost, mlPrice, saleFee, fixedFee, shipping,
        freeShippingApplies: freeShippingApplies({ mlPrice, saleFee, fixedFee, shipping }),
      });
    } catch (err: any) {
      row.error = String(err?.response?.data?.message ?? err?.message ?? 'Error de Mercado Libre').slice(0, 200);
    }
  }

  // Resumen sobre los que se pudieron calcular.
  const ok = rows.filter((r) => r.result) as Array<ProfitRow & { result: MlProfit }>;
  // Valor típico = MEDIANA, no promedio: un solo producto con el costo mal cargado (costo mayor
  // que el precio) arrastraba el promedio de toda la muestra.
  const avg = (xs: Array<number | null>) => {
    const v = xs.filter((x): x is number => x != null && Number.isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return null;
    const mid = Math.floor(v.length / 2);
    return Math.round((v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2) * 10) / 10;
  };
  return {
    candidates: products.length, markupPct, logistic, listingType: LISTING,
    rows,
    summary: {
      calculated: ok.length,
      storeMarginPct: avg(ok.map((r) => r.result.storeMarginPct)),
      mlMarginPct: avg(ok.map((r) => r.result.marginPct)),
      // Escenario real (envío gratis a cargo del vendedor solo donde ML lo exige).
      realMarginPct: avg(ok.map((r) => r.result.realMarginPct)),
      losingReal: ok.filter((r) => r.result.realProfit < 0).length,
      equalMarkupRealPct: avg(ok.map((r) => r.result.equalMarkupRealPct)),
      withFreeShipping: ok.filter((r) => r.result.freeShippingApplies).length,
      realMarginBelowPct: avg(ok.filter((r) => !r.result.freeShippingApplies).map((r) => r.result.realMarginPct)),
      realMarginAbovePct: avg(ok.filter((r) => r.result.freeShippingApplies).map((r) => r.result.realMarginPct)),
      mlMarginFreeShippingPct: avg(ok.map((r) => r.result.marginFreeShippingPct)),
      losing: ok.filter((r) => r.result.profit < 0).length,
      losingFreeShipping: ok.filter((r) => r.result.profitFreeShipping != null && r.result.profitFreeShipping < 0).length,
      equalMarkupPct: avg(ok.map((r) => r.result.equalMarkupPct)),
      equalMarkupFreeShippingPct: avg(ok.map((r) => r.result.equalMarkupFreeShippingPct)),
    },
  };
}
