import { prisma } from '../db.js';

// Stock inicial (al comienzo del período) y final (al cierre) por variante+sucursal.
// No hay ledger: se reconstruye desde las fuentes (ventas/devoluciones/transferencias/
// ajustes de auditoría), igual que services/movements.ts, pero para TODO el catálogo.
//
// El stock ACTUAL es la verdad. Hacia atrás:
//   stockFinal   = actual − Σ(deltas con fecha > to)
//   stockInicial = stockFinal − Σ(deltas con from ≤ fecha ≤ to)
// Solo importan los movimientos con fecha ≥ from (los anteriores no afectan ninguno
// de los dos valores calculados desde el actual). Volumen chico → se reduce en memoria.
export async function getStockSnapshot(opts: { from: string; to: string; branchId?: string }) {
  const from = new Date(opts.from);
  const to = new Date(opts.to);
  const branchFilter = opts.branchId || undefined;
  const key = (v: string, b: string) => `${v}|${b}`;

  // Stock actual por variante+sucursal.
  const stocks = await prisma.stock.findMany({
    where: branchFilter ? { branchId: branchFilter } : undefined,
    select: { variantId: true, branchId: true, qty: true },
  });
  const current = new Map<string, number>();
  for (const s of stocks) current.set(key(s.variantId, s.branchId), s.qty);

  const inPeriod = new Map<string, number>();
  const afterTo = new Map<string, number>();
  const add = (m: Map<string, number>, k: string, d: number) => m.set(k, (m.get(k) || 0) + d);
  const place = (dt: Date, v: string, b: string, delta: number) => {
    if (!v || !b || !delta) return;
    if (branchFilter && b !== branchFilter) return;
    if (dt > to) add(afterTo, key(v, b), delta);
    else if (dt >= from) add(inPeriod, key(v, b), delta);
    // dt < from → no afecta inicial ni final (se calculan desde el actual hacia atrás).
  };

  // Ventas confirmadas (delta −qty).
  const saleItems = await prisma.saleItem.findMany({
    where: { sale: { status: 'confirmed', datetime: { gte: from } } },
    select: { variantId: true, qty: true, sale: { select: { datetime: true, branchId: true } } },
  });
  for (const si of saleItems) if (si.sale) place(si.sale.datetime, si.variantId, si.sale.branchId, -si.qty);

  // Devoluciones: devuelto +qty, llevado (canje) −qty.
  const returns = await prisma.return.findMany({
    where: { datetime: { gte: from } },
    select: { datetime: true, branchId: true, returnedItems: true, takenItems: true },
  });
  for (const r of returns) {
    for (const it of ((r.returnedItems as any[]) || [])) place(r.datetime, it.variantId, r.branchId, Number(it.qty) || 0);
    for (const it of ((r.takenItems as any[]) || [])) place(r.datetime, it.variantId, r.branchId, -(Number(it.qty) || 0));
  }

  // Transferencias confirmadas: origen −qty, destino +qty.
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

  // Ajustes/recepciones (auditoría de stock): delta = after − before, entityId = `variantId|branch`.
  const audits = await prisma.auditLog.findMany({
    where: { entity: 'stock', datetime: { gte: from } },
    select: { datetime: true, entityId: true, before: true, after: true },
  });
  for (const a of audits) {
    const [vid, b] = String(a.entityId || '').split('|');
    const delta = ((a.after as any)?.qty ?? 0) - ((a.before as any)?.qty ?? 0);
    place(a.datetime, vid, b, delta);
  }

  const keys = new Set<string>([...current.keys(), ...inPeriod.keys(), ...afterTo.keys()]);
  const rows: { variantId: string; branchId: string; inicial: number; final: number; movPeriodo: number }[] = [];
  for (const k of keys) {
    const [variantId, branchId] = k.split('|');
    const cur = current.get(k) || 0;
    const ip = inPeriod.get(k) || 0;
    const at = afterTo.get(k) || 0;
    const final = cur - at;
    const inicial = final - ip;
    rows.push({ variantId, branchId, inicial, final, movPeriodo: ip });
  }
  return { from: opts.from, to: opts.to, branchId: branchFilter || null, rows };
}
