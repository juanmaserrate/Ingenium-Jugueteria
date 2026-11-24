import { MlClient } from './client.js';
import { pickListingPrice, freeShippingApplies, solveTargetPrice, type FeeQuote, type TargetPrice } from './massPure.js';

// Precio de Mercado Libre "para ganar lo mismo que en el local": se busca el precio al que, una
// vez descontado lo que cobra ML (comisión + costo fijo, o el envío gratis donde es obligatorio),
// al vendedor le queda el precio del sistema. Las comisiones se le preguntan a ML producto por
// producto (dependen de la categoría, el precio y el peso); se cachean dentro de la corrida.

const SITE = 'MLA';
const DEFAULT_WEIGHT_G = 1000;
const DEFAULT_DIM_CM = 20;
// Si dejar el precio justo debajo del monto de envío gratis conserva al menos esta parte de lo
// que se gana en el local, se prefiere eso a subirlo mucho para cubrir el envío.
export const CAP_RATIO = 0.9;

export type PricingCtx = {
  ml: MlClient;
  userId: string;
  listingTypeId: string;
  logistic: string;
  threshold: number | null; // monto desde el que ML obliga al envío gratis (detectado)
  cache: Map<string, FeeQuote>;
};

export async function newPricingCtx(ml: MlClient, userId: string, listingTypeId: string, logistic = 'drop_off'): Promise<PricingCtx> {
  return { ml, userId, listingTypeId, logistic, threshold: null, cache: new Map() };
}

export async function feeQuote(ctx: PricingCtx, categoryId: string, price: number, weightG: number, dims?: { h?: number | null; w?: number | null; d?: number | null }): Promise<FeeQuote> {
  const key = `${categoryId}|${price}|${weightG}`;
  const hit = ctx.cache.get(key);
  if (hit) return hit;
  const lp = await ctx.ml.listingPrices(SITE, {
    price, currency_id: 'ARS', category_id: categoryId, listing_type_id: ctx.listingTypeId,
    logistic_type: ctx.logistic, shipping_mode: 'me2', billable_weight: weightG,
  });
  const entry = pickListingPrice(lp, ctx.listingTypeId);
  if (!entry || entry.sale_fee_amount == null) throw new Error('Mercado Libre no informó la comisión');
  const saleFee = Number(entry.sale_fee_amount) || 0;
  const fixedFee = Number(entry.sale_fee_details?.fixed_fee) || 0;
  // El envío solo importa donde ML dejó de cobrar el costo fijo (envío gratis obligatorio).
  let shipping: number | null = null;
  if (!(fixedFee > 0) && price >= 5000) {
    try {
      const dim = (v?: number | null) => Math.max(1, Math.round(v && v > 0 ? v : DEFAULT_DIM_CM));
      const q: any = await ctx.ml.freeShippingQuote(ctx.userId, {
        dimensions: `${dim(dims?.h)}x${dim(dims?.w)}x${dim(dims?.d)},${weightG}`,
        item_price: price, listing_type_id: ctx.listingTypeId, mode: 'me2', condition: 'new',
        logistic_type: ctx.logistic, free_shipping: true, verbose: true,
      });
      const cost = Number(q?.coverage?.all_country?.list_cost);
      shipping = Number.isFinite(cost) && cost > 0 ? cost : null;
    } catch { /* sin cotización */ }
  }
  const quote: FeeQuote = { saleFee, fixedFee, shipping, applies: freeShippingApplies({ mlPrice: price, saleFee, fixedFee, shipping }) };
  ctx.cache.set(key, quote);
  return quote;
}

// Monto desde el que ML obliga al envío gratis: el menor precio (múltiplo de $10) en el que deja
// de cobrar costo fijo. Se busca una vez por corrida. null si no se pudo determinar.
export async function detectThreshold(ctx: PricingCtx, categoryId: string): Promise<number | null> {
  if (ctx.threshold != null) return ctx.threshold;
  try {
    const fixedAt = async (p: number) => (await feeQuote(ctx, categoryId, p, DEFAULT_WEIGHT_G)).fixedFee;
    let lo = 10000, hi = 150000;
    if (!((await fixedAt(lo)) > 0) || (await fixedAt(hi)) > 0) return null;
    while (hi - lo > 10) {
      const mid = Math.round((lo + hi) / 20) * 10;
      if ((await fixedAt(mid)) > 0) lo = mid; else hi = mid;
    }
    ctx.threshold = hi;
    return hi;
  } catch { return null; }
}

export function weightGrams(weightKg: number | null | undefined): number {
  return weightKg && weightKg > 0 ? Math.round(weightKg * 1000) : DEFAULT_WEIGHT_G;
}

export async function targetPriceFor(ctx: PricingCtx, input: { categoryId: string; storePrice: number; weightKg?: number | null; dims?: { h?: number | null; w?: number | null; d?: number | null } }): Promise<TargetPrice> {
  const w = weightGrams(input.weightKg);
  const threshold = await detectThreshold(ctx, input.categoryId);
  return solveTargetPrice({
    target: input.storePrice,
    quote: (p) => feeQuote(ctx, input.categoryId, p, w, input.dims),
    threshold, capRatio: CAP_RATIO,
  });
}
