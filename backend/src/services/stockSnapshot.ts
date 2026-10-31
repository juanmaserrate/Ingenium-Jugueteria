import { prisma } from '../db.js';

const KEY = (v: string, b: string) => `${v}|${b}`;

// Mes actual en horario Argentina (UTC−3): 'YYYY-MM'.
function arMonthKey(d: Date = new Date()): string {
  return new Date(d.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 7);
}
function nextMonthKey(key: string): string {
  let [y, m] = key.split('-').map(Number);
  m += 1; if (m > 12) { m = 1; y += 1; }
  return `${y}-${String(m).padStart(2, '0')}`;
}
function lastDayOfMonth(y: number, m1: number): number {
  return new Date(y, m1, 0).getDate(); // m1 = mes 1-based
}

// Captura la foto del stock del mes actual si todavía no existe. Idempotente: el unique
// (periodKey, variantId, branchId) + skipDuplicates evita duplicados aunque corra en paralelo.
// periodKey = mes actual = stock al COMIENZO de este mes (se toma la primera vez que el
// server corre en el mes). Lo llama el worker al bootear y una vez por hora.
export async function ensureMonthlySnapshot(): Promise<{ created: number; periodKey: string; skipped?: boolean }> {
  const periodKey = arMonthKey();
  const existing = await prisma.stockSnapshot.count({ where: { periodKey } });
  if (existing > 0) return { created: 0, periodKey, skipped: true };
  const stocks = await prisma.stock.findMany({ select: { variantId: true, branchId: true, qty: true } });
  if (stocks.length === 0) return { created: 0, periodKey };
  const res = await prisma.stockSnapshot.createMany({
    data: stocks.map((s) => ({ periodKey, variantId: s.variantId, branchId: s.branchId, qty: s.qty })),
    skipDuplicates: true,
  });
  return { created: res.count, periodKey };
}

// Partes de fecha en horario Argentina (UTC−3).
function arParts(d: Date) {
  const x = new Date(d.getTime() - 3 * 3600 * 1000);
  return { y: x.getUTCFullYear(), m: x.getUTCMonth() + 1, day: x.getUTCDate() };
}

// Carga la foto de un mes SOLO si sirve como borde de mes: tomada en los primeros 3 días
// de ese mismo mes. Así, si el sistema se activó a mitad de mes, esa foto tardía NO se usa
// como "inicio de mes" (el reporte reconstruye, que para meses recientes es exacto igual).
// Qué meses de foto hay guardados (para visibilidad/ops).
export async function listStockSnapshots() {
  const grouped = await prisma.stockSnapshot.groupBy({
    by: ['periodKey'],
    _count: { _all: true },
    _min: { takenAt: true },
    orderBy: { periodKey: 'desc' },
  });
  return grouped.map((g) => ({ periodKey: g.periodKey, filas: g._count._all, tomadaEl: g._min.takenAt }));
}

async function loadBoundarySnapshot(periodKey: string, branchFilter?: string): Promise<Map<string, number>> {
  const rows = await prisma.stockSnapshot.findMany({
    where: { periodKey, ...(branchFilter ? { branchId: branchFilter } : {}) },
    select: { variantId: true, branchId: true, qty: true, takenAt: true },
  });
  if (rows.length === 0) return new Map();
  const [y, m] = periodKey.split('-').map(Number);
  const p = arParts(rows[0].takenAt);
  if (!(p.y === y && p.m === m && p.day <= 3)) return new Map(); // tomada tarde → no es borde válido
  const map = new Map<string, number>();
  for (const r of rows) map.set(KEY(r.variantId, r.branchId), r.qty);
  return map;
}

// Stock inicial (comienzo del período) y final (cierre) por variante+sucursal.
// Preferencia: si hay FOTO mensual (StockSnapshot) alineada al borde del período, se usa
// (exacto, sin depender del historial). Si no, se RECONSTRUYE hacia atrás desde el stock
// actual restando ventas/devoluciones/transferencias/ajustes (fallback para meses viejos
// y para el mes en curso, cuyo "final" = stock actual y es exacto igual).
export async function getStockSnapshot(opts: { from: string; to: string; branchId?: string }) {
  const from = new Date(opts.from);
  const to = new Date(opts.to);
  const branchFilter = opts.branchId || undefined;

  // --- Stock actual (ancla de la reconstrucción) ---
  const stocks = await prisma.stock.findMany({
    where: branchFilter ? { branchId: branchFilter } : undefined,
    select: { variantId: true, branchId: true, qty: true },
  });
  const current = new Map<string, number>();
  for (const s of stocks) current.set(KEY(s.variantId, s.branchId), s.qty);

  // --- Deltas para la reconstrucción (solo fecha ≥ from) ---
  const inPeriod = new Map<string, number>();
  const afterTo = new Map<string, number>();
  const add = (m: Map<string, number>, k: string, d: number) => m.set(k, (m.get(k) || 0) + d);
  const place = (dt: Date, v: string, b: string, delta: number) => {
    if (!v || !b || !delta) return;
    if (branchFilter && b !== branchFilter) return;
    if (dt > to) add(afterTo, KEY(v, b), delta);
    else if (dt >= from) add(inPeriod, KEY(v, b), delta);
  };

  const saleItems = await prisma.saleItem.findMany({
    where: { sale: { status: 'confirmed', datetime: { gte: from } } },
    select: { variantId: true, qty: true, sale: { select: { datetime: true, branchId: true } } },
  });
  for (const si of saleItems) if (si.sale) place(si.sale.datetime, si.variantId, si.sale.branchId, -si.qty);

  const returns = await prisma.return.findMany({
    where: { datetime: { gte: from } },
    select: { datetime: true, branchId: true, returnedItems: true, takenItems: true },
  });
  for (const r of returns) {
    for (const it of ((r.returnedItems as any[]) || [])) place(r.datetime, it.variantId, r.branchId, Number(it.qty) || 0);
    for (const it of ((r.takenItems as any[]) || [])) place(r.datetime, it.variantId, r.branchId, -(Number(it.qty) || 0));
  }

  const transfers = await prisma.transfer.findMany({
    where: { status: 'confirmed' },
    select: { datetime: true, confirmedAt: true, fromBranch: true, toBranch: true, items: true },
  });
  for (const t of transfers) {
    const when = t.confirmedAt || t.datetime;
    if (when < from) continue;
    for (const it of ((t.items as any[]) || [])) {
      const q = Number(it.qty) || 0;
      place(when, it.variantId, t.fromBranch, -q);
      place(when, it.variantId, t.toBranch, q);
    }
  }

  const audits = await prisma.auditLog.findMany({
    where: { entity: 'stock', datetime: { gte: from } },
    select: { datetime: true, entityId: true, before: true, after: true },
  });
  for (const a of audits) {
    const [vid, b] = String(a.entityId || '').split('|');
    const delta = ((a.after as any)?.qty ?? 0) - ((a.before as any)?.qty ?? 0);
    place(a.datetime, vid, b, delta);
  }

  // --- Fotos mensuales alineadas al período ---
  const fromKey = opts.from.slice(0, 7);          // 'YYYY-MM' del comienzo
  const isFromMonthStart = opts.from.slice(8, 10) === '01';
  const [ty, tm, td] = opts.to.slice(0, 10).split('-').map(Number);
  const isToMonthEnd = td === lastDayOfMonth(ty, tm);
  const finalKey = nextMonthKey(opts.to.slice(0, 7)); // el inicio del mes SIGUIENTE = cierre de 'to'

  const snapFrom = isFromMonthStart ? await loadBoundarySnapshot(fromKey, branchFilter) : new Map<string, number>();
  const snapFinal = isToMonthEnd ? await loadBoundarySnapshot(finalKey, branchFilter) : new Map<string, number>();
  const usedSnapInicial = snapFrom.size > 0;
  const usedSnapFinal = snapFinal.size > 0;

  const keys = new Set<string>([...current.keys(), ...inPeriod.keys(), ...afterTo.keys(), ...snapFrom.keys(), ...snapFinal.keys()]);
  const rows: { variantId: string; branchId: string; inicial: number; final: number; movPeriodo: number }[] = [];
  for (const k of keys) {
    const [variantId, branchId] = k.split('|');
    const reconFinal = (current.get(k) || 0) - (afterTo.get(k) || 0);
    const reconInicial = reconFinal - (inPeriod.get(k) || 0);
    const final = usedSnapFinal && snapFinal.has(k) ? (snapFinal.get(k) as number) : reconFinal;
    const inicial = usedSnapInicial && snapFrom.has(k) ? (snapFrom.get(k) as number) : reconInicial;
    rows.push({ variantId, branchId, inicial, final, movPeriodo: final - inicial });
  }

  return {
    from: opts.from,
    to: opts.to,
    branchId: branchFilter || null,
    source: { inicial: usedSnapInicial ? 'snapshot' : 'reconstruido', final: usedSnapFinal ? 'snapshot' : 'reconstruido' },
    rows,
  };
}
