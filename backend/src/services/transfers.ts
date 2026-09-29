import { prisma } from '../db.js';
import { randomId } from '../utils/crypto.js';
import { nextCounter } from './counters.js';
import { adjustStock } from './stock.js';
import { enqueueSync } from '../sync/queue.js';
import { ValidationError } from '../utils/errors.js';

export type TransferItem = { variantId: string; qty: number; [k: string]: unknown };

export async function listTransfers(opts: { branchId?: string; status?: string; from?: string; to?: string; limit?: number } = {}) {
  const where: any = {};
  if (opts.branchId) where.OR = [{ fromBranch: opts.branchId }, { toBranch: opts.branchId }];
  if (opts.status) where.status = opts.status;
  if (opts.from || opts.to) {
    where.datetime = {};
    if (opts.from) where.datetime.gte = new Date(opts.from);
    if (opts.to) where.datetime.lt = new Date(opts.to);
  }
  return prisma.transfer.findMany({
    where: Object.keys(where).length ? where : undefined,
    orderBy: { datetime: 'desc' },
    take: opts.limit ?? 500,
  });
}

// Crea una transferencia PENDIENTE: NO mueve stock todavía. El stock recién se
// mueve cuando la sucursal destino la CONFIRMA (confirmTransfer). Así el stock
// (y lo que ve Tienda Nube) no cambia mientras está pendiente.
export async function createTransfer(input: {
  fromBranch: string;
  toBranch: string;
  items: TransferItem[];
  notes?: string | null;
  userId?: string;
}) {
  const { fromBranch, toBranch, userId } = input;
  const items = (input.items || [])
    .filter((i) => i.variantId && Number(i.qty) > 0)
    .map((i) => ({ variantId: i.variantId, qty: Math.trunc(Number(i.qty)) }));
  if (fromBranch === toBranch) throw new ValidationError('Origen y destino deben ser distintos');
  if (!items.length) throw new ValidationError('La transferencia no tiene items');

  // Chequeo temprano (no bloqueante en el tiempo): el origen debe tener el stock
  // al momento de crear. La validación atómica real se hace al confirmar.
  for (const it of items) {
    const st = await prisma.stock.findUnique({ where: { id: `${it.variantId}|${fromBranch}` } });
    const avail = (st?.qty ?? 0);
    if (avail < it.qty) {
      throw new ValidationError(`No hay stock suficiente en el origen para transferir (disponible ${avail}, pedís ${it.qty})`);
    }
  }

  const number = await nextCounter('transfer');
  return prisma.transfer.create({
    data: {
      id: randomId(),
      number,
      datetime: new Date(),
      fromBranch,
      toBranch,
      items: items as any,
      status: 'pending',
      notes: input.notes ?? null,
      userId: userId ?? null,
    },
  });
}

// Confirma la recepción (la hace la sucursal destino): recién acá se mueve el
// stock, de forma atómica. Mismo comportamiento TN que antes (skipTnSync + un
// push_stock por variante → TN-neutral con stockMode 'sum').
export async function confirmTransfer(id: string, userId?: string) {
  const t = await prisma.transfer.findUnique({ where: { id } });
  if (!t) throw new ValidationError('Transferencia no encontrada');
  if (t.status !== 'pending') throw new ValidationError(`La transferencia ya está ${t.status === 'confirmed' ? 'confirmada' : 'resuelta'}`);
  const items = (t.items as any[]) || [];

  await prisma.$transaction(async (tx) => {
    // Guarda atómica: solo si sigue pendiente (evita doble confirmación concurrente).
    const res = await tx.transfer.updateMany({
      where: { id, status: 'pending' },
      data: { status: 'confirmed', confirmedAt: new Date(), confirmedBy: userId ?? null },
    });
    if (res.count !== 1) throw new ValidationError('La transferencia ya fue confirmada o resuelta');
    // Mover stock: origen − / destino + (si el origen ya no tiene stock, revierte todo).
    for (const it of items) {
      const qty = Math.trunc(Number(it.qty));
      await adjustStock(it.variantId, t.fromBranch, -qty, { userId, reason: `Transfer #${t.number} to ${t.toBranch}`, skipTnSync: true, noNegative: true, tx });
      await adjustStock(it.variantId, t.toBranch, qty, { userId, reason: `Transfer #${t.number} from ${t.fromBranch}`, skipTnSync: true, tx });
    }
  });

  for (const it of items) await enqueueSync('push_stock', { variantId: it.variantId });
  return prisma.transfer.findUnique({ where: { id } });
}

// Rechaza (destino) o cancela (origen) una transferencia pendiente. No mueve stock.
export async function resolveTransfer(id: string, status: 'rejected' | 'cancelled', opts: { userId?: string; reason?: string } = {}) {
  const res = await prisma.transfer.updateMany({
    where: { id, status: 'pending' },
    data: { status, reason: opts.reason ?? null, confirmedBy: opts.userId ?? null, confirmedAt: new Date() },
  });
  if (res.count !== 1) throw new ValidationError('Solo se puede rechazar/cancelar una transferencia pendiente');
  return prisma.transfer.findUnique({ where: { id } });
}

// Importa SOLO el registro (remito) de una transferencia vieja que quedó local.
// NO mueve stock (ese ya se movió cuando se creó) ni toca TN. Es para preservar
// el historial al migrar del navegador al servidor.
export async function importTransferRecord(input: {
  fromBranch: string;
  toBranch: string;
  items?: unknown;
  notes?: string | null;
  userId?: string;
  datetime?: string | null;
}) {
  const number = await nextCounter('transfer');
  return prisma.transfer.create({
    data: {
      id: randomId(),
      number,
      datetime: input.datetime ? new Date(input.datetime) : new Date(),
      fromBranch: input.fromBranch,
      toBranch: input.toBranch,
      items: (input.items ?? []) as any,
      status: 'confirmed',
      notes: input.notes ?? null,
      userId: input.userId ?? null,
    },
  });
}
