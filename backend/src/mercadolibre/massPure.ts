// Lógica PURA (sin base ni red) de la publicación masiva en Mercado Libre.
// Tests: backend/tests/ml.test.ts.

export type MassVariant = {
  id: string;
  value: string;      // valor distintivo ("Rojo", "M / Azul") o '' si es la default
  stock: number;      // disponible sumando sucursales
  linked: boolean;    // ya tiene publicación de ML vinculada
  price: number;      // precio propio o el del producto
  hasGtin: boolean;
  isDefault?: boolean;
};

export type MassProduct = {
  id: string;
  name: string;
  code: string;
  hasPicture: boolean;       // foto propia o publicado en Tienda Nube (se toma de ahí)
  productLinked: boolean;    // vínculo a nivel producto
  variants: MassVariant[];
};

export type MassStatus = 'ready' | 'linked' | 'no_stock' | 'on_ml' | 'no_price' | 'no_picture';

export type MassVerdict = {
  status: MassStatus;
  listings: number;          // publicaciones que se crearían
  variantIds: string[];      // variantes que se publicarían
  stock: number;             // unidades que quedarían publicadas
  noGtin: boolean;           // aviso: alguna va sin código de barras (ML puede rechazarla)
};

// ¿El producto sale como "una publicación por variante"? Mismo criterio que publish.ts:
// más de una variante y al menos dos valores distintivos diferentes.
export function isFanOut(variants: MassVariant[]): boolean {
  const vals = variants.map((v) => v.value).filter(Boolean);
  return variants.length > 1 && vals.length >= 2 && new Set(vals).size >= 2;
}

// Decide qué hacer con UN producto. `onMl` = el producto (o alguna de sus variantes a publicar)
// ya tiene una publicación en Mercado Libre SIN vincular: publicarlo crearía un duplicado.
export function classifyForMl(p: MassProduct, onMl: { product: boolean; variantIds: Set<string> }): MassVerdict {
  const none = (status: MassStatus): MassVerdict => ({ status, listings: 0, variantIds: [], stock: 0, noGtin: false });
  let pending: MassVariant[];
  if (isFanOut(p.variants)) {
    // Una publicación por variante: se publican las que tienen stock y todavía no están vinculadas.
    const withStock = p.variants.filter((v) => v.value && v.stock > 0);
    if (!withStock.length) return none('no_stock');
    pending = withStock.filter((v) => !v.linked);
    if (!pending.length) return none('linked');
  } else {
    // Publicación simple: representa a la variante principal y lleva SU stock.
    const main = p.variants.find((v) => v.isDefault) ?? p.variants[0];
    if (!main) return none('no_stock');
    if (p.productLinked || main.linked) return none('linked');
    if (main.stock <= 0) return none('no_stock');
    pending = [main];
  }
  if (onMl.product || pending.some((v) => onMl.variantIds.has(v.id))) return none('on_ml');
  if (pending.some((v) => !(v.price > 0))) return none('no_price');
  if (!p.hasPicture) return none('no_picture');
  return {
    status: 'ready',
    listings: pending.length,
    variantIds: pending.map((v) => v.id),
    stock: pending.reduce((s, v) => s + v.stock, 0),
    noGtin: pending.some((v) => !v.hasGtin),
  };
}

// Precio con recargo para Mercado Libre, redondeado a pesos enteros. Sin recargo, el mismo.
export function priceWithFactor(price: number, factor?: number | null): number {
  const p = Number(price) || 0;
  if (!factor || !(factor > 0) || factor === 1) return p;
  return Math.round(p * factor);
}

// --- Ganancia estimada vendiendo por Mercado Libre ---
export type MlProfit = {
  mlPrice: number;         // precio publicado (precio del sistema + recargo)
  saleFee: number;         // lo que cobra ML por vender (comisión % + costo fijo)
  feePct: number;          // comisión % efectiva (sin el costo fijo)
  fixedFee: number;
  shipping: number | null; // envío gratis a cargo del vendedor, si ML lo cotizó
  profit: number;          // ganancia si el envío lo paga el comprador
  marginPct: number;
  profitFreeShipping: number | null; // ganancia si el envío gratis corre por cuenta del vendedor
  marginFreeShippingPct: number | null;
  storeProfit: number;     // ganancia vendiéndolo en el local al precio del sistema
  storeMarginPct: number;
  // Recargo (%) sobre el precio del sistema para ganar lo MISMO que en el local.
  equalMarkupPct: number | null;
  equalMarkupFreeShippingPct: number | null;
};

const r2 = (n: number) => Math.round(n * 100) / 100;

export function mlProfit(input: { storePrice: number; cost: number; mlPrice: number; saleFee: number; fixedFee?: number | null; shipping?: number | null }): MlProfit {
  const storePrice = Number(input.storePrice) || 0;
  const cost = Number(input.cost) || 0;
  const mlPrice = Number(input.mlPrice) || 0;
  const saleFee = Math.max(0, Number(input.saleFee) || 0);
  const fixedFee = Math.min(saleFee, Math.max(0, Number(input.fixedFee) || 0));
  const shipping = input.shipping != null && Number(input.shipping) > 0 ? Number(input.shipping) : null;
  const pct = mlPrice > 0 ? (saleFee - fixedFee) / mlPrice : 0; // fracción

  const profit = mlPrice - saleFee - cost;
  const storeProfit = storePrice - cost;
  const profitFree = shipping != null ? profit - shipping : null;
  // precio' tal que precio' − (pct·precio' + fijo) − envío − costo = ganancia del local
  const equalPrice = (ship: number) => (pct < 1 ? (storeProfit + cost + fixedFee + ship) / (1 - pct) : NaN);
  const asMarkup = (p: number) => (storePrice > 0 && Number.isFinite(p) ? r2((p / storePrice - 1) * 100) : null);

  return {
    mlPrice: r2(mlPrice), saleFee: r2(saleFee), feePct: r2(pct * 100), fixedFee: r2(fixedFee), shipping: shipping != null ? r2(shipping) : null,
    profit: r2(profit), marginPct: mlPrice > 0 ? r2((profit / mlPrice) * 100) : 0,
    profitFreeShipping: profitFree != null ? r2(profitFree) : null,
    marginFreeShippingPct: profitFree != null && mlPrice > 0 ? r2((profitFree / mlPrice) * 100) : null,
    storeProfit: r2(storeProfit), storeMarginPct: storePrice > 0 ? r2((storeProfit / storePrice) * 100) : 0,
    equalMarkupPct: asMarkup(equalPrice(0)),
    equalMarkupFreeShippingPct: shipping != null ? asMarkup(equalPrice(shipping)) : null,
  };
}

// La respuesta de listing_prices puede venir como objeto, lista o lista de listas.
export function pickListingPrice(res: any, listingTypeId: string): any | null {
  const flat: any[] = [];
  const walk = (x: any) => { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === 'object') flat.push(x); };
  walk(res);
  return flat.find((e) => e?.listing_type_id === listingTypeId) ?? (flat.length === 1 ? flat[0] : null);
}

// Traduce el resultado de publishProduct a un motivo que entienda quien lee el listado.
export function publishFailureReason(res: any): string {
  if (!res) return 'Sin respuesta';
  switch (res.error) {
    case 'no_picture': return 'Sin foto';
    case 'no_price': return 'Sin precio';
    case 'no_category': return 'No se pudo determinar la categoría de Mercado Libre';
    case 'not_found': return 'Producto no encontrado';
    case 'missing_attributes': {
      const names = (Array.isArray(res.missing) ? res.missing : []).map((m: any) => m?.name || m?.id).filter(Boolean);
      return `Faltan datos obligatorios de la categoría: ${names.join(', ') || 'sin detalle'}`;
    }
    case 'ml_rejected': {
      const list = Array.isArray(res.details) ? res.details : [res.details];
      const msgs: string[] = [];
      for (const d of list) {
        if (d == null) continue;
        if (typeof d === 'string') { msgs.push(d); continue; }
        const causes: any[] = Array.isArray(d.cause) ? d.cause : [];
        const errs = causes.filter((c) => c?.type !== 'warning').map((c) => c?.message || c?.code).filter(Boolean);
        if (errs.length) msgs.push(...errs); else if (d.message) msgs.push(String(d.message));
      }
      const uniq = [...new Set(msgs.map((m) => String(m).trim()).filter(Boolean))];
      return `Mercado Libre lo rechazó: ${uniq.join(' | ').slice(0, 400) || 'sin detalle'}`;
    }
    default: return String(res.message || res.error || 'Error desconocido').slice(0, 400);
  }
}

// ¿El rechazo indica que ML frenó la cuenta/la app (límite, permisos)? Ahí no tiene sentido seguir.
export function isHardStop(res: any): boolean {
  const list = Array.isArray(res?.details) ? res.details : [res?.details];
  return list.some((d: any) => d && typeof d === 'object' && [401, 403, 429].includes(Number(d.status)));
}
