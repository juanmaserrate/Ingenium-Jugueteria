import { getSetting } from './settings.js';

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

type Acquirer = {
  id: string; name: string; kind?: string;
  debit_pct?: number; credit_pct?: number;
  fin3?: number; fin6?: number; fin12?: number;
  days_debit?: number; days_credit?: number; days_cuotas?: number;
  fixed_monthly?: number; tn_platform_pct?: number; active?: boolean;
};
type Promo = {
  id: string; name: string; bank?: string; card_type?: string; acquirer_id?: string;
  installments?: number; discount_pct?: number; discount_funder?: string;
  tope_amount?: number; tope_mode?: string;
};

async function configs(): Promise<{ acquirers: Acquirer[]; promosByMonth: Record<string, Promo[]> }> {
  const acquirers = ((await getSetting('acquirers')) as Acquirer[]) || [];
  const promosByMonth = ((await getSetting('promos')) as Record<string, Promo[]>) || {};
  return { acquirers, promosByMonth };
}

function findPromo(promosByMonth: Record<string, Promo[]>, promoId: string): Promo | null {
  for (const list of Object.values(promosByMonth || {})) {
    const hit = (list || []).find((p) => p.id === promoId);
    if (hit) return hit;
  }
  return null;
}

// Costo de un pago según el adquirente y el plan (comisión + financiero cuotas + plataforma TN).
function computeCost(opts: { acquirer: Acquirer | null; cardType?: string; installments?: number; amount: number; includePlatform?: boolean }) {
  const a = opts.acquirer;
  const inst = Math.max(1, opts.installments || 1);
  const card = (opts.cardType || 'credito').toLowerCase();
  if (!a) return { commissionPct: 0, financingPct: 0, platformPct: 0, costPct: 0, costAmount: 0, settlementDays: 0 };
  const commissionPct = card === 'debito' ? (a.debit_pct || 0) : card === 'credito' ? (a.credit_pct || 0) : 0;
  const financingPct = inst <= 1 ? 0 : inst <= 3 ? (a.fin3 || 0) : inst <= 6 ? (a.fin6 || 0) : (a.fin12 || 0);
  const platformPct = opts.includePlatform ? (a.tn_platform_pct || 0) : 0;
  const costPct = round2(commissionPct + financingPct + platformPct);
  const costAmount = round2((opts.amount * costPct) / 100);
  const settlementDays = card === 'debito' ? (a.days_debit ?? 2) : inst > 1 ? (a.days_cuotas ?? 2) : (a.days_credit ?? 10);
  return { commissionPct, financingPct, platformPct, costPct, costAmount, settlementDays };
}

function addDays(d: Date, days: number): string {
  const x = new Date(d.getTime());
  x.setDate(x.getDate() + (days || 0));
  return x.toISOString();
}

// POS: el pago referencia una promo por su id → sacamos banco/adquirente/cuotas y calculamos.
// Devuelve null si el método no es una promo con adquirente (ej. Efectivo) → sin costo.
export async function buildCostMetaForPromo(methodId: string, amount: number, datetime: Date) {
  if (!methodId) return null;
  const { acquirers, promosByMonth } = await configs();
  const promo = findPromo(promosByMonth, methodId);
  if (!promo) return null;
  const acquirer = promo.acquirer_id ? acquirers.find((a) => a.id === promo.acquirer_id) || null : null;
  const c = computeCost({ acquirer, cardType: promo.card_type, installments: promo.installments, amount, includePlatform: false });
  return {
    source: 'pos', promoId: promo.id, promoName: promo.name, bank: promo.bank || null,
    acquirerId: acquirer?.id || null, acquirerName: acquirer?.name || null,
    cardType: promo.card_type || null, installments: Math.max(1, promo.installments || 1),
    ...c, creditDate: addDays(datetime, c.settlementDays),
    discountFunder: promo.discount_funder || 'banco', discountPct: promo.discount_pct || 0,
  };
}

// Tienda Nube: no pasa por el selector. Sacamos gateway + cuotas de la orden y matcheamos
// un adquirente por nombre; la comisión de plataforma TN aplica salvo con Pago Nube.
export async function buildCostMetaForTn(order: any, amount: number, datetime: Date) {
  const { acquirers } = await configs();
  const gateway = String(order?.gateway_name || order?.gateway || 'Tienda Nube');
  const installments = Math.max(1, Number(order?.payment_details?.installments) || 1);
  const method = String(order?.payment_details?.method || '').toLowerCase();
  const cardType = method.includes('debit') ? 'debito' : 'credito';
  const gl = gateway.toLowerCase();
  const acquirer =
    acquirers.find((a) => a.kind === 'online' && a.name && gl.includes(a.name.toLowerCase())) ||
    acquirers.find((a) => a.kind === 'online' && a.name && a.name.toLowerCase().includes(gl)) ||
    acquirers.find((a) => a.kind === 'online') || null;
  const includePlatform = !/pago\s*nube/i.test(gateway);
  const c = computeCost({ acquirer, cardType, installments, amount, includePlatform });
  return {
    source: 'tn', promoId: null, promoName: 'Tienda Nube', bank: gateway,
    acquirerId: acquirer?.id || null, acquirerName: acquirer?.name || null,
    cardType, installments, ...c, creditDate: addDays(datetime, c.settlementDays),
    discountFunder: 'banco', discountPct: 0,
  };
}
