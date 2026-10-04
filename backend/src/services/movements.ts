import { prisma } from '../db.js';

// Historial de movimientos de stock de UN producto (todas sus variantes).
// No hay ledger central: se reconstruye desde las distintas fuentes, cada movimiento
// contado UNA sola vez:
//   - Ventas        → SaleItem            (sale en tx, no audita)   delta -
//   - Devoluciones  → Return (JSON items) (adjustStock en tx)       delta +/-
//   - Transferencias→ Transfer (JSON)     (adjustStock en tx)       delta -/+ (2 patas)
//   - Recep./ajustes→ AuditLog entity=stock (adjustStock standalone) delta +/-
// El balance por sucursal se calcula hacia atrás desde el stock actual (que es la verdad).
export async function getProductMovements(productId: string, opts: { limit?: number } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 2000);
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { variants: { include: { stocks: true } } },
  });
  if (!product) throw new Error('Producto no encontrado');

  const variantIds = product.variants.map((v) => v.id);
  const vName = new Map(product.variants.map((v) => [v.id, v.name && v.name !== 'default' ? v.name : '']));
  const vset = new Set(variantIds);

  // Stock actual por sucursal (verdad para calcular balances hacia atrás).
  const stockNow: Record<string, number> = {};
  for (const v of product.variants) for (const s of v.stocks) stockNow[s.branchId] = (stockNow[s.branchId] || 0) + s.qty;

  type Mov = { datetime: Date; type: string; branchId: string; variantId: string | null; variantName: string; delta: number; ref: string; detail: string; userId: string | null };
  const movs: Mov[] = [];

  // --- Ventas ---
  const saleItems = await prisma.saleItem.findMany({
    where: { variantId: { in: variantIds }, sale: { status: 'confirmed' } },
    include: { sale: { select: { number: true, datetime: true, branchId: true } } },
    orderBy: { sale: { datetime: 'desc' } },
    take: limit,
  });
  for (const si of saleItems) {
    if (!si.sale) continue;
    movs.push({ datetime: si.sale.datetime, type: 'venta', branchId: si.sale.branchId, variantId: si.variantId, variantName: vName.get(si.variantId || '') || '', delta: -si.qty, ref: `Venta #${String(si.sale.number).padStart(6, '0')}`, detail: '', userId: null });
  }

  // --- Recepciones + ajustes manuales (audit de stock) ---
  const entityIds: string[] = [];
  for (const vid of variantIds) for (const br of ['br_lomas', 'br_banfield']) entityIds.push(`${vid}|${br}`);
  const audits = await prisma.auditLog.findMany({
    where: { entity: 'stock', entityId: { in: entityIds } },
    orderBy: { datetime: 'desc' },
    take: limit,
  });
  for (const a of audits) {
    const [vid, branchId] = String(a.entityId || '').split('|');
    const before = (a.before as any)?.qty ?? 0;
    const after = (a.after as any)?.qty ?? 0;
    const delta = after - before;
    if (delta === 0) continue;
    const desc = a.description || '';
    const isCompra = /^Compra #/i.test(desc);
    movs.push({ datetime: a.datetime, type: isCompra ? 'compra' : 'ajuste', branchId, variantId: vid, variantName: vName.get(vid) || '', delta, ref: isCompra ? desc : 'Ajuste', detail: isCompra ? '' : desc, userId: a.userId });
  }

  // --- Transferencias (confirmadas) ---
  const transfers = await prisma.transfer.findMany({ where: { status: 'confirmed' }, orderBy: { datetime: 'desc' }, take: 1000 });
  for (const t of transfers) {
    const items = (t.items as any[]) || [];
    for (const it of items) {
      if (!vset.has(it.variantId)) continue;
      const qty = Number(it.qty) || 0;
      if (!qty) continue;
      const when = t.confirmedAt || t.datetime;
      movs.push({ datetime: when, type: 'transferencia', branchId: t.fromBranch, variantId: it.variantId, variantName: vName.get(it.variantId) || '', delta: -qty, ref: `Transfer #${t.number}`, detail: `→ ${t.toBranch.replace('br_', '')}`, userId: t.userId });
      movs.push({ datetime: when, type: 'transferencia', branchId: t.toBranch, variantId: it.variantId, variantName: vName.get(it.variantId) || '', delta: qty, ref: `Transfer #${t.number}`, detail: `← ${t.fromBranch.replace('br_', '')}`, userId: t.userId });
    }
  }

  // --- Devoluciones / canjes ---
  const returns = await prisma.return.findMany({ orderBy: { datetime: 'desc' }, take: 1000 });
  for (const r of returns) {
    const ret = (r.returnedItems as any[]) || [];
    const tak = (r.takenItems as any[]) || [];
    for (const it of ret) {
      if (!vset.has(it.variantId)) continue;
      movs.push({ datetime: r.datetime, type: 'devolucion', branchId: r.branchId, variantId: it.variantId, variantName: vName.get(it.variantId) || '', delta: Number(it.qty) || 0, ref: `Devol. #${String(r.number).padStart(6, '0')}`, detail: 'devuelto', userId: null });
    }
    for (const it of tak) {
      if (!vset.has(it.variantId)) continue;
      movs.push({ datetime: r.datetime, type: 'devolucion', branchId: r.branchId, variantId: it.variantId, variantName: vName.get(it.variantId) || '', delta: -(Number(it.qty) || 0), ref: `Devol. #${String(r.number).padStart(6, '0')}`, detail: 'llevado (canje)', userId: null });
    }
  }

  // Orden cronológico descendente.
  movs.sort((a, b) => new Date(b.datetime).getTime() - new Date(a.datetime).getTime());

  // Balance por sucursal, hacia atrás desde el stock actual.
  const running: Record<string, number> = { ...stockNow };
  const out = movs.map((m) => {
    const balAfter = running[m.branchId] ?? 0;
    running[m.branchId] = balAfter - m.delta; // balance antes de este movimiento
    return { ...m, balance: balAfter };
  });

  return {
    product: { id: product.id, name: product.name, code: product.code },
    stockByBranch: stockNow,
    count: out.length,
    movements: out.slice(0, limit),
  };
}
