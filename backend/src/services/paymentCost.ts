import { getSetting } from './settings.js';

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// Forma de pago con su costo plegado (modelo "todo dentro del medio"). Se mantienen los
// campos viejos (debit_pct/credit_pct/days_*) como compat por si quedó config del modelo
// anterior basado en adquirentes.
type Method = {
  id: string; name: string; card_type?: string; kind?: string;
  commission_pct?: number; fin3?: number; fin6?: number; fin12?: number;
  settle_days?: number; settle_days_cuotas?: number; tn_platform_pct?: number;
  debit_pct?: number; credit_pct?: number; days_debit?: number; days_credit?: number; days_cuotas?: number;
};
type Promo = {
  id: string; name?: string; method_id?: string; installments?: number;
  discount_pct?: number; tope_amount?: number;
};

async function cfg(): Promise<{ methods: Method[]; promos: Promo[] }> {
  const methods = ((await getSetting('payment_methods')) as Method[]) || [];
  const raw = (await getSetting('promos')) as any;
  // Promos: array plano (modelo nuevo). Tolera el shape viejo { "YYYY-MM": [...] }.
  const promos: Promo[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' ? (Object.values(raw).flat() as Promo[]) : [];
  return { methods, promos };
}

function methodCommission(m: Method): number {
  if (typeof m.commission_pct === 'number') return m.commission_pct || 0;
  // compat modelo viejo (adquirente): usa débito/crédito según el tipo del medio.
  return (m.card_type || '').toLowerCase() === 'debito' ? (m.debit_pct || 0) : (m.credit_pct || 0);
}

function settleDays(m: Method, installments: number): number {
  if (installments > 1) return m.settle_days_cuotas ?? m.days_cuotas ?? m.settle_days ?? 2;
  const ct = (m.card_type || '').toLowerCase();
  if (ct === 'debito') return m.settle_days ?? m.days_debit ?? 2;
  return m.settle_days ?? m.days_credit ?? 10;
}

function computeCost(method: Method | null, installments: number, amount: number, includePlatform: boolean) {
  if (!method) return { commissionPct: 0, financingPct: 0, platformPct: 0, costPct: 0, costAmount: 0, settlementDays: 0 };
  const inst = Math.max(1, installments || 1);
  const commissionPct = methodCommission(method);
  const financingPct = inst <= 1 ? 0 : inst <= 3 ? (method.fin3 || 0) : inst <= 6 ? (method.fin6 || 0) : (method.fin12 || 0);
  const platformPct = includePlatform ? (method.tn_platform_pct || 0) : 0;
  const costPct = round2(commissionPct + financingPct + platformPct);
  const costAmount = round2((amount * costPct) / 100);
  return { commissionPct, financingPct, platformPct, costPct, costAmount, settlementDays: settleDays(method, inst) };
}

function addDays(d: Date, days: number): string {
  const x = new Date(d.getTime());
  x.setDate(x.getDate() + (days || 0));
  return x.toISOString();
}

// POS: el pago referencia una PROMO por id, o directamente el id de la FORMA DE PAGO (sin
// promo). El costo (comisión + financiero de cuotas) sale de la forma de pago; la promo
// aporta las cuotas y el descuento (este último informativo, NO cambia el total de la venta).
// Devuelve null si no hay promo y el medio no tiene costo (ej. Efectivo).
export async function buildCostMetaForPromo(idOrPromoId: string, amount: number, datetime: Date) {
  if (!idOrPromoId) return null;
  const { methods, promos } = await cfg();
  const promo = promos.find((p) => p.id === idOrPromoId) || null;
  const methodId = promo ? promo.method_id : idOrPromoId;
  const method = methods.find((m) => m.id === methodId) || null;
  if (!method) return null;
  const installments = Math.max(1, Number(promo?.installments) || 1);
  const c = computeCost(method, installments, amount, false);
  if (!promo && c.costPct === 0) return null; // medio plano sin costo → sin cost_meta
  return {
    source: 'pos', promoId: promo?.id || null, promoName: promo?.name || method.name,
    bank: method.name, methodId: method.id, methodName: method.name,
    acquirerId: null, acquirerName: method.name,
    cardType: method.card_type || null, installments,
    ...c, creditDate: addDays(datetime, c.settlementDays),
    discountFunder: 'banco', discountPct: Number(promo?.discount_pct) || 0,
  };
}

// Mercado Libre: la comisión real (sale_fee) viene en la propia orden → NO se estima. Se
// suma el sale_fee de cada item y se guarda como costAmount; costPct se deriva del monto.
// Mantiene el shape de cost_meta que consume el reporte de ganancia (reports.js repProfit).
export async function buildCostMetaForMl(order: any, amount: number, datetime: Date) {
  const items = order?.order_items ?? [];
  const saleFee = round2(items.reduce((s: number, oi: any) => s + (Number(oi?.sale_fee) || 0), 0));
  const costPct = amount > 0 ? round2((saleFee / amount) * 100) : 0;
  // Acreditación: ML suele liberar el dinero según su calendario (post-entrega). Sin un dato
  // confiable en la orden, dejamos creditDate = fecha de la venta (se puede refinar luego).
  return {
    source: 'ml', promoId: null, promoName: 'Mercado Libre', bank: 'Mercado Pago',
    methodId: 'mercadolibre', methodName: 'Mercado Libre',
    acquirerId: null, acquirerName: 'Mercado Pago',
    cardType: null, installments: 1,
    commissionPct: costPct, financingPct: 0, platformPct: 0, costPct,
    costAmount: saleFee, settlementDays: 0, creditDate: datetime.toISOString(),
    discountFunder: 'banco', discountPct: 0,
  };
}

// Tienda Nube: no pasa por el selector. Usa una forma de pago marcada como "online" (kind)
// para la comisión + plataforma; la plataforma aplica salvo con Pago Nube. Si no hay ningún
// medio online configurado, el costo queda en 0 hasta que se configure.
export async function buildCostMetaForTn(order: any, amount: number, datetime: Date) {
  const { methods } = await cfg();
  const gateway = String(order?.gateway_name || order?.gateway || 'Tienda Nube');
  const installments = Math.max(1, Number(order?.payment_details?.installments) || 1);
  const method = String(order?.payment_details?.method || '').toLowerCase();
  const gl = gateway.toLowerCase();
  const online = methods.filter((m) => m.kind === 'online');
  const m =
    online.find((a) => a.name && gl.includes(a.name.toLowerCase())) ||
    online.find((a) => a.name && a.name.toLowerCase().includes(gl)) ||
    online[0] || null;
  const includePlatform = !/pago\s*nube/i.test(gateway);
  const c = computeCost(m, installments, amount, includePlatform);
  return {
    source: 'tn', promoId: null, promoName: 'Tienda Nube', bank: gateway,
    methodId: m?.id || null, methodName: m?.name || 'Tienda Nube',
    acquirerId: null, acquirerName: m?.name || gateway,
    cardType: method.includes('debit') ? 'debito' : 'credito', installments,
    ...c, creditDate: addDays(datetime, c.settlementDays),
    discountFunder: 'banco', discountPct: 0,
  };
}
