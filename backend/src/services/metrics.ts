import { prisma } from '../db.js';
import type { Prisma } from '@prisma/client';

// =========================================================
// MÉTRICAS / INFORMES (lectura agregada desde Postgres)
// El negocio es argentino (UTC-3). Construimos los rangos de fecha en hora
// Argentina para que "hoy" / "este mes" coincidan con lo que ve el operador.
// Las ventas cuentan con status 'confirmed' (excluye canceladas/borrador).
// branchId ausente = consolidado (todas las sucursales).
// =========================================================

const AR = '-03:00';

function monthRange(month: string) {
  // month: 'YYYY-MM'
  const [y, m] = month.split('-').map(Number);
  const gte = new Date(`${month}-01T00:00:00.000${AR}`);
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  const lt = new Date(`${nextY}-${String(nextM).padStart(2, '0')}-01T00:00:00.000${AR}`);
  return { gte, lt };
}
function prevMonthStr(month: string) {
  const [y, m] = month.split('-').map(Number);
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return `${py}-${String(pm).padStart(2, '0')}`;
}
function dayRange(day: string) {
  // day: 'YYYY-MM-DD'
  const gte = new Date(`${day}T00:00:00.000${AR}`);
  const lt = new Date(gte.getTime() + 24 * 60 * 60 * 1000);
  return { gte, lt };
}
function prevDayStr(day: string) {
  const d = new Date(`${day}T12:00:00.000${AR}`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
function branchWhere(branchId?: string): Prisma.SaleWhereInput {
  return branchId ? { branchId } : {};
}

const confirmed = { status: 'confirmed' as const };

// ---------- DASHBOARD ----------
export async function getDashboard(params: { branchId?: string; month: string; today: string }) {
  const { branchId, month, today } = params;
  const mr = monthRange(month);
  const pm = monthRange(prevMonthStr(month));
  const tr = dayRange(today);
  const yr = dayRange(prevDayStr(today));
  const bw = branchWhere(branchId);

  const sumTotal = (where: Prisma.SaleWhereInput) =>
    prisma.sale.aggregate({ _sum: { total: true }, _count: true, where: { ...bw, ...confirmed, ...where } });

  const [todayAgg, yesterdayAgg, monthAggR, prevMonthAggR] = await Promise.all([
    sumTotal({ datetime: { gte: tr.gte, lt: tr.lt } }),
    sumTotal({ datetime: { gte: yr.gte, lt: yr.lt } }),
    sumTotal({ datetime: { gte: mr.gte, lt: mr.lt } }),
    sumTotal({ datetime: { gte: pm.gte, lt: pm.lt } }),
  ]);

  // Caja: saldo acumulado (todos los movimientos hasta hoy)
  const cashAgg = await prisma.cashMovement.aggregate({
    _sum: { amountIn: true, amountOut: true }, _count: true,
    where: branchId ? { branchId } : {},
  });
  const cashBalance = (cashAgg._sum.amountIn ?? 0) - (cashAgg._sum.amountOut ?? 0);

  // Inventario a costo/venta y stock crítico
  const stocks = await prisma.stock.findMany({
    where: branchId ? { branchId } : {},
    include: { variant: { include: { product: true } } },
  });
  let invValueCost = 0, invValueSale = 0, invUnits = 0, outOfStock = 0, lowStock = 0;
  // Para "sin stock" / "bajo" a nivel producto en la sucursal:
  for (const s of stocks) {
    const p = s.variant?.product;
    if (!p) continue;
    invUnits += s.qty;
    invValueCost += s.qty * (p.cost || 0);
    invValueSale += s.qty * (p.price || 0);
    if (s.qty === 0) outOfStock++;
  }

  // Cheques pendientes
  const checks = await prisma.check.findMany({ where: { status: 'pending' } });
  const todayD = new Date(`${today}T00:00:00${AR}`);
  const soon = new Date(todayD.getTime() + 7 * 24 * 60 * 60 * 1000);
  const checksPendingSum = checks.reduce((s, c) => s + (c.amount || 0), 0);
  const checksOverdue = checks.filter((c) => c.dueAt && c.dueAt < todayD).length;
  const checksSoon = checks.filter((c) => c.dueAt && c.dueAt >= todayD && c.dueAt <= soon).length;

  // Gastos y devoluciones del mes
  const expAgg = await prisma.expense.aggregate({
    _sum: { amount: true },
    where: { ...(branchId ? { branchId } : {}), datetime: { gte: mr.gte, lt: mr.lt } },
  });
  const retAgg = await prisma.return.aggregate({
    _sum: { returnedTotal: true },
    where: { ...(branchId ? { branchId } : {}), datetime: { gte: mr.gte, lt: mr.lt } },
  });

  // Medios de pago del mes (groupBy methodId sobre pagos de ventas del mes)
  const payments = await prisma.salePayment.groupBy({
    by: ['methodId', 'methodName'],
    _sum: { amount: true },
    where: { sale: { ...bw, ...confirmed, datetime: { gte: mr.gte, lt: mr.lt } } },
  });
  const methods = payments.map((p) => ({ methodId: p.methodId, methodName: p.methodName, amount: p._sum.amount ?? 0 }))
    .sort((a, b) => b.amount - a.amount);

  // Top productos del mes (Σ qty por variante → producto)
  const itemsAgg = await prisma.saleItem.groupBy({
    by: ['variantId', 'productNameSnap'],
    _sum: { qty: true, subtotal: true },
    where: { sale: { ...bw, ...confirmed, datetime: { gte: mr.gte, lt: mr.lt } } },
  });
  const topProducts = itemsAgg
    .map((i) => ({ name: i.productNameSnap, qty: i._sum.qty ?? 0, subtotal: i._sum.subtotal ?? 0 }))
    .sort((a, b) => b.qty - a.qty).slice(0, 8);

  // Ventas por categoría del mes: necesitamos variant→product→category
  const variantIds = itemsAgg.map((i) => i.variantId);
  const variants = await prisma.variant.findMany({
    where: { id: { in: variantIds } },
    include: { product: { include: { category: true } } },
  });
  const catByVariant = new Map(variants.map((v) => [v.id, v.product?.category?.name || 'Sin categoría']));
  const catTotals: Record<string, number> = {};
  for (const i of itemsAgg) {
    const cat = catByVariant.get(i.variantId) || 'Sin categoría';
    catTotals[cat] = (catTotals[cat] || 0) + (i._sum.subtotal ?? 0);
  }
  const byCategory = Object.entries(catTotals).map(([name, total]) => ({ name, total }))
    .sort((a, b) => b.total - a.total);

  // Serie de 30 días (ventas por día)
  const serieFrom = new Date(tr.lt.getTime() - 30 * 24 * 60 * 60 * 1000);
  const serieSales = await prisma.sale.findMany({
    where: { ...bw, ...confirmed, datetime: { gte: serieFrom, lt: tr.lt } },
    select: { datetime: true, total: true },
  });
  const serieMap: Record<string, number> = {};
  for (const s of serieSales) {
    const key = new Date(s.datetime.getTime() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10); // a fecha AR
    serieMap[key] = (serieMap[key] || 0) + (s.total || 0);
  }
  const serie30 = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(tr.gte.getTime() - i * 24 * 60 * 60 * 1000);
    const key = new Date(d.getTime() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
    serie30.push({ day: key, total: Number((serieMap[key] || 0).toFixed(2)) });
  }

  // Cumpleaños del mes
  const mm = month.split('-')[1];
  const customers = await prisma.customer.findMany({ where: { birthday: { not: null } }, select: { birthday: true } });
  const birthdays = customers.filter((c) => c.birthday && String(c.birthday.toISOString().slice(5, 7)) === mm).length;

  // Actividad reciente
  const recentSales = await prisma.sale.findMany({
    where: { ...bw, ...confirmed }, orderBy: { datetime: 'desc' }, take: 10,
    select: { number: true, datetime: true, total: true, branchId: true },
  });

  const monthTotal = monthAggR._sum.total ?? 0;
  const monthCount = monthAggR._count ?? 0;
  return {
    today: { total: todayAgg._sum.total ?? 0, count: todayAgg._count ?? 0 },
    yesterday: { total: yesterdayAgg._sum.total ?? 0 },
    month: { total: monthTotal, count: monthCount, avgTicket: monthCount ? monthTotal / monthCount : 0 },
    prevMonth: { total: prevMonthAggR._sum.total ?? 0, count: prevMonthAggR._count ?? 0 },
    cash: { balance: cashBalance, movements: cashAgg._count ?? 0 },
    inventory: { valueCost: invValueCost, valueSale: invValueSale, units: invUnits, outOfStock, lowStock },
    checks: { count: checks.length, sum: checksPendingSum, overdue: checksOverdue, soon: checksSoon },
    expensesMonth: expAgg._sum.amount ?? 0,
    returnsMonth: retAgg._sum.returnedTotal ?? 0,
    birthdays,
    methods, topProducts, byCategory, serie30,
    recent: recentSales,
  };
}

// ---------- BALANCE / SALDO ----------
export async function getBalance(params: { branchId?: string; from: string; to: string }) {
  const { branchId, from, to } = params;
  const gte = new Date(from); const lt = new Date(to);
  const bw = branchWhere(branchId);
  const where = { ...bw, ...confirmed, datetime: { gte, lt } };

  const [agg, payments, sales, returns] = await Promise.all([
    prisma.sale.aggregate({ _sum: { total: true }, _count: true, where }),
    prisma.salePayment.groupBy({ by: ['methodId', 'methodName'], _sum: { amount: true }, where: { sale: where } }),
    prisma.sale.findMany({ where, orderBy: { datetime: 'desc' }, take: 1000,
      select: { id: true, number: true, datetime: true, total: true, branchId: true, payments: { select: { methodName: true, amount: true } } } }),
    prisma.return.findMany({ where: { ...(branchId ? { branchId } : {}), datetime: { gte, lt } },
      orderBy: { datetime: 'desc' }, take: 1000,
      select: { id: true, number: true, datetime: true, returnedTotal: true, takenTotal: true, difference: true } }),
  ]);
  const facturado = agg._sum.total ?? 0;
  const count = agg._count ?? 0;
  const devuelto = returns.reduce((s, r) => s + Math.max(0, -(r.difference || 0)), 0);
  return {
    facturado, devuelto, neto: facturado - devuelto, count,
    avgTicket: count ? facturado / count : 0,
    methods: payments.map((p) => ({ methodId: p.methodId, methodName: p.methodName, amount: p._sum.amount ?? 0 })).sort((a, b) => b.amount - a.amount),
    sales, returns,
  };
}

// ---------- PROFITS / GANANCIAS (P&L mensual) ----------
export async function getProfits(params: { branchId?: string; month: string }) {
  const { branchId, month } = params;
  const mr = monthRange(month);
  const bw = branchWhere(branchId);
  const where = { ...bw, ...confirmed, datetime: { gte: mr.gte, lt: mr.lt } };

  const [salesAgg, items, expAgg, returns, checks] = await Promise.all([
    prisma.sale.aggregate({ _sum: { total: true }, _count: true, where }),
    prisma.saleItem.findMany({
      where: { sale: where },
      select: { qty: true, costSnapshot: true, subtotal: true, variantId: true },
    }),
    prisma.expense.aggregate({ _sum: { amount: true }, where: { ...(branchId ? { branchId } : {}), datetime: { gte: mr.gte, lt: mr.lt } } }),
    prisma.return.findMany({ where: { ...(branchId ? { branchId } : {}), datetime: { gte: mr.gte, lt: mr.lt } }, select: { difference: true } }),
    prisma.check.findMany({ where: { dueAt: { gte: mr.gte, lt: mr.lt } }, select: { amount: true } }),
  ]);

  const ventasBrutas = salesAgg._sum.total ?? 0;
  const cogs = items.reduce((s, it) => s + (it.costSnapshot || 0) * (it.qty || 0), 0);
  const gananciaBruta = ventasBrutas - cogs;
  const gastos = expAgg._sum.amount ?? 0;
  const cheques = checks.reduce((s, c) => s + (c.amount || 0), 0);
  const devueltoCliente = returns.reduce((s, r) => s + Math.max(0, -(r.difference || 0)), 0);
  const gananciaNeta = gananciaBruta - gastos - cheques - devueltoCliente;

  // Por categoría
  const variantIds = [...new Set(items.map((i) => i.variantId))];
  const variants = await prisma.variant.findMany({ where: { id: { in: variantIds } }, include: { product: { include: { category: true } } } });
  const catByVariant = new Map(variants.map((v) => [v.id, v.product?.category?.name || 'Sin categoría']));
  const byCatMap: Record<string, { sales: number; cost: number; qty: number }> = {};
  for (const it of items) {
    const cat = catByVariant.get(it.variantId) || 'Sin categoría';
    byCatMap[cat] = byCatMap[cat] || { sales: 0, cost: 0, qty: 0 };
    byCatMap[cat].sales += it.subtotal || 0;
    byCatMap[cat].cost += (it.costSnapshot || 0) * (it.qty || 0);
    byCatMap[cat].qty += it.qty || 0;
  }
  const byCategory = Object.entries(byCatMap).map(([name, v]) => ({
    name, sales: v.sales, cost: v.cost, qty: v.qty,
    marginPct: v.sales > 0 ? ((v.sales - v.cost) / v.sales) * 100 : 0,
  })).sort((a, b) => b.sales - a.sales);

  return {
    ventasBrutas, cogs, gananciaBruta, gastos, cheques, devueltoCliente, gananciaNeta,
    count: salesAgg._count ?? 0, byCategory,
  };
}

// ---------- CONTRIBUTION / CONTRIBUCIÓN MARGINAL ----------
export async function getContribution(params: { branchId?: string; month: string; view: string; topN?: number }) {
  const { branchId, month, view } = params;
  const topN = params.topN ?? 50;
  const mr = monthRange(month);
  const bw = branchWhere(branchId);
  const items = await prisma.saleItem.findMany({
    where: { sale: { ...bw, ...confirmed, datetime: { gte: mr.gte, lt: mr.lt } } },
    select: { qty: true, costSnapshot: true, subtotal: true, productNameSnap: true, variantId: true },
  });
  const variantIds = [...new Set(items.map((i) => i.variantId))];
  const variants = await prisma.variant.findMany({
    where: { id: { in: variantIds } },
    include: { product: { include: { category: true, brand: true, supplier: true } } },
  });
  const vmap = new Map(variants.map((v) => [v.id, v]));
  const keyOf = (vid: string) => {
    const v = vmap.get(vid); const p = v?.product;
    if (view === 'category') return p?.category?.name || 'Sin categoría';
    if (view === 'brand') return p?.brand?.name || 'Sin marca';
    if (view === 'supplier') return p?.supplier?.name || 'Sin proveedor';
    return p?.name || 'Producto';
  };
  const map: Record<string, { sales: number; cost: number; qty: number }> = {};
  for (const it of items) {
    const k = keyOf(it.variantId);
    map[k] = map[k] || { sales: 0, cost: 0, qty: 0 };
    map[k].sales += it.subtotal || 0;
    map[k].cost += (it.costSnapshot || 0) * (it.qty || 0);
    map[k].qty += it.qty || 0;
  }
  const totalSales = Object.values(map).reduce((s, v) => s + v.sales, 0);
  const totalCM = Object.values(map).reduce((s, v) => s + (v.sales - v.cost), 0);
  const rows = Object.entries(map).map(([name, v]) => {
    const cm = v.sales - v.cost;
    return {
      name, sales: v.sales, cost: v.cost, qty: v.qty, cm,
      cmPct: v.sales > 0 ? (cm / v.sales) * 100 : 0,
      shareOfSales: totalSales > 0 ? (v.sales / totalSales) * 100 : 0,
      shareOfCM: totalCM > 0 ? (cm / totalCM) * 100 : 0,
    };
  }).sort((a, b) => b.cm - a.cm).slice(0, topN);
  return { totalSales, totalCM, marginPct: totalSales > 0 ? (totalCM / totalSales) * 100 : 0, rows };
}

// ---------- AUDIT / HISTORIAL ----------
export async function getAudit(params: { from?: string; to?: string; action?: string; entity?: string; userId?: string; q?: string }) {
  const where: Prisma.AuditLogWhereInput = {};
  if (params.from || params.to) {
    where.datetime = {};
    if (params.from) (where.datetime as any).gte = new Date(params.from);
    if (params.to) (where.datetime as any).lt = new Date(params.to);
  }
  if (params.action) where.action = params.action;
  if (params.entity) where.entity = params.entity;
  if (params.userId) where.userId = params.userId;
  if (params.q) where.description = { contains: params.q, mode: 'insensitive' };
  return prisma.auditLog.findMany({ where, orderBy: { datetime: 'desc' }, take: 500 });
}
