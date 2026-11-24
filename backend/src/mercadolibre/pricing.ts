import { MlClient } from './client.js';
import { pickListingPrice, freeShippingApplies, solveTargetPrice, packageFor, DEFAULT_PACKAGE, type FeeQuote, type TargetPrice, type Package } from './massPure.js';

// Precio de Mercado Libre "para ganar lo mismo que en el local": se busca el precio al que, una
// vez descontado lo que cobra ML (comisión + costo fijo, o el envío gratis donde es obligatorio),
// al vendedor le queda el precio del sistema. Las comisiones se le preguntan a ML producto por
// producto (dependen de la categoría, el precio y el peso); se cachean dentro de la corrida.

const SITE = 'MLA';
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

export async function feeQuote(ctx: PricingCtx, categoryId: string, price: number, pkg: Package): Promise<FeeQuote> {
  const weightG = pkg.weightG;
  const key = `${categoryId}|${price}|${weightG}|${pkg.heightCm}x${pkg.widthCm}x${pkg.lengthCm}`;
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
      const q: any = await ctx.ml.freeShippingQuote(ctx.userId, {
        dimensions: `${pkg.heightCm}x${pkg.widthCm}x${pkg.lengthCm},${weightG}`,
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
    const std: Package = { ...DEFAULT_PACKAGE, assumed: true };
    const fixedAt = async (p: number) => (await feeQuote(ctx, categoryId, p, std)).fixedFee;
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

export async function targetPriceFor(ctx: PricingCtx, input: { categoryId: string; storePrice: number; product: { weight?: number | null; height?: number | null; width?: number | null; depth?: number | null } }): Promise<TargetPrice> {
  const pkg = packageFor(input.product);
  const threshold = await detectThreshold(ctx, input.categoryId);
  return solveTargetPrice({
    target: input.storePrice,
    quote: (p) => feeQuote(ctx, input.categoryId, p, pkg),
    threshold, capRatio: CAP_RATIO,
  });
}
