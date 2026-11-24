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
