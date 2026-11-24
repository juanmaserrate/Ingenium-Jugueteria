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
  // Lo que pasa DE VERDAD: desde cierto precio Mercado Libre obliga al envío gratis (lo paga
  // el vendedor y a cambio no cobra costo fijo); por debajo, el envío lo paga el comprador.
  freeShippingApplies: boolean;
  realProfit: number;
  realMarginPct: number;
  equalMarkupRealPct: number | null;
};

const r2 = (n: number) => Math.round(n * 100) / 100;

export function mlProfit(input: { storePrice: number; cost: number; mlPrice: number; saleFee: number; fixedFee?: number | null; shipping?: number | null; freeShippingApplies?: boolean }): MlProfit {
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
  const applies = !!input.freeShippingApplies && shipping != null;
  const real = applies ? profit - shipping! : profit;

  return {
    mlPrice: r2(mlPrice), saleFee: r2(saleFee), feePct: r2(pct * 100), fixedFee: r2(fixedFee), shipping: shipping != null ? r2(shipping) : null,
    profit: r2(profit), marginPct: mlPrice > 0 ? r2((profit / mlPrice) * 100) : 0,
    profitFreeShipping: profitFree != null ? r2(profitFree) : null,
    marginFreeShippingPct: profitFree != null && mlPrice > 0 ? r2((profitFree / mlPrice) * 100) : null,
    storeProfit: r2(storeProfit), storeMarginPct: storePrice > 0 ? r2((storeProfit / storePrice) * 100) : 0,
    equalMarkupPct: asMarkup(equalPrice(0)),
    equalMarkupFreeShippingPct: shipping != null ? asMarkup(equalPrice(shipping)) : null,
    freeShippingApplies: applies,
    realProfit: r2(real),
    realMarginPct: mlPrice > 0 ? r2((real / mlPrice) * 100) : 0,
    equalMarkupRealPct: asMarkup(equalPrice(applies ? shipping! : 0)),
  };
}

// ¿A este precio Mercado Libre obliga al envío gratis? No hay un dato directo: se deduce de
// que ML deja de cobrar el costo fijo (lo cobra solo por debajo del monto de envío gratis).
// El piso de precio evita confundirlo con productos casi regalados, donde el fijo también es 0.
export function freeShippingApplies(input: { mlPrice: number; saleFee: number; fixedFee: number; shipping: number | null }): boolean {
  return input.shipping != null && input.shipping > 0 && input.saleFee > 0 && !(input.fixedFee > 0) && input.mlPrice >= 5000;
}

// --- Paquete: Mercado Libre exige peso y medidas en TODA publicación ---
// Mismo paquete estándar que propone la pantalla de Inventario al publicar. Se usa cuando el
// producto no tiene sus propias medidas cargadas (hoy, casi todos).
export const DEFAULT_PACKAGE = { weightG: 500, heightCm: 15, widthCm: 20, lengthCm: 20 };

export type Package = { weightG: number; heightCm: number; widthCm: number; lengthCm: number; assumed: boolean };

export function packageFor(p: { weight?: number | null; height?: number | null; width?: number | null; depth?: number | null }): Package {
  const pos = (v: unknown) => (Number(v) > 0 ? Number(v) : 0);
  const w = pos(p.weight), h = pos(p.height), wd = pos(p.width), d = pos(p.depth);
  return {
    weightG: w ? Math.max(1, Math.round(w * 1000)) : DEFAULT_PACKAGE.weightG, // el sistema guarda kg
    heightCm: h ? Math.max(1, Math.round(h)) : DEFAULT_PACKAGE.heightCm,
    widthCm: wd ? Math.max(1, Math.round(wd)) : DEFAULT_PACKAGE.widthCm,
    lengthCm: d ? Math.max(1, Math.round(d)) : DEFAULT_PACKAGE.lengthCm,
    assumed: !(w && h && wd && d),
  };
}

// Peso (kg) y medidas (cm) que tiene cargados el producto en Tienda Nube. TN los guarda por
// variante y como texto ("0.350"); se toma el mayor de cada uno (el paquete más grande).
export function tnDimensions(tnProduct: any): { weight: number; height: number; width: number; depth: number } {
  const out = { weight: 0, height: 0, width: 0, depth: 0 };
  const vs: any[] = Array.isArray(tnProduct?.variants) ? tnProduct.variants : [];
  for (const v of vs) {
    for (const k of ['weight', 'height', 'width', 'depth'] as const) {
      const n = Number(v?.[k]);
      if (Number.isFinite(n) && n > out[k]) out[k] = n;
    }
  }
  return out;
}

// Completa lo que le falta al producto con lo de Tienda Nube (lo propio tiene prioridad).
export function mergeDimensions<T extends { weight?: number | null; height?: number | null; width?: number | null; depth?: number | null }>(own: T, tn: { weight: number; height: number; width: number; depth: number } | null) {
  if (!tn) return { weight: own.weight ?? null, height: own.height ?? null, width: own.width ?? null, depth: own.depth ?? null };
  const pick = (a: number | null | undefined, b: number) => (Number(a) > 0 ? Number(a) : b > 0 ? b : null);
  return { weight: pick(own.weight, tn.weight), height: pick(own.height, tn.height), width: pick(own.width, tn.width), depth: pick(own.depth, tn.depth) };
}

export function packageAttributes(pkg: Package): Array<{ id: string; value_name: string }> {
  return [
    { id: 'SELLER_PACKAGE_WEIGHT', value_name: `${pkg.weightG} g` },
    { id: 'SELLER_PACKAGE_HEIGHT', value_name: `${pkg.heightCm} cm` },
    { id: 'SELLER_PACKAGE_WIDTH', value_name: `${pkg.widthCm} cm` },
    { id: 'SELLER_PACKAGE_LENGTH', value_name: `${pkg.lengthCm} cm` },
  ];
}

// --- Precio objetivo: que en Mercado Libre quede lo mismo que vendiendo en el local ---
export type FeeQuote = { saleFee: number; fixedFee: number; shipping: number | null; applies: boolean };
export type TargetPrice = {
  price: number;        // precio a publicar
  net: number;          // lo que queda después de lo que cobra ML (y del envío si corre por cuenta del vendedor)
  target: number;       // lo que se buscaba que quede (precio del sistema)
  freeShipping: boolean;
  capped: boolean;      // se dejó justo debajo del monto de envío gratis
};

const up10 = (n: number) => Math.ceil(Math.round(n * 100) / 100 / 10) * 10; // a decenas, hacia arriba
export const netOf = (price: number, q: FeeQuote) => price - q.saleFee - (q.applies && q.shipping ? q.shipping : 0);

// Busca el precio al que queda `target` en mano. `quote` devuelve lo que cobra ML a un precio
// dado (cambia por tramos: el costo fijo depende del precio y, desde cierto monto, se reemplaza
// por el envío gratis a cargo del vendedor), así que se itera subiendo hasta que cierra.
export async function solveTargetPrice(input: {
  target: number;
  quote: (price: number) => Promise<FeeQuote>;
  threshold?: number | null;
  capRatio?: number;
}): Promise<TargetPrice> {
  const target = Number(input.target) || 0;
  let price = up10(target);
  let q = await input.quote(price);
  for (let i = 0; i < 6; i++) {
    if (netOf(price, q) >= target - 0.5) break;
    const pct = price > 0 ? Math.max(0, Math.min(0.9, (q.saleFee - q.fixedFee) / price)) : 0;
    const extra = q.fixedFee + (q.applies && q.shipping ? q.shipping : 0);
    const next = Math.max(price + 10, up10((target + extra) / (1 - pct)));
    price = next;
    q = await input.quote(price);
  }
  let result: TargetPrice = { price, net: Math.round(netOf(price, q) * 100) / 100, target, freeShipping: q.applies, capped: false };

  // Cerca del monto de envío gratis: si quedando justo debajo se conserva casi todo, se prefiere
  // eso a subir mucho el precio para cubrir un envío que pasaría a pagar el vendedor.
  const th = input.threshold;
  if (q.applies && th && th > 10) {
    const cap = th - 10;
    if (cap < price) {
      const qc = await input.quote(cap);
      const netCap = netOf(cap, qc);
      if (!qc.applies && netCap >= (input.capRatio ?? 0.9) * target) {
        result = { price: cap, net: Math.round(netCap * 100) / 100, target, freeShipping: false, capped: true };
      }
    }
  }
  return result;
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
