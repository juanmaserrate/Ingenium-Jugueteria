import { prisma } from '../db.js';
import { randomId } from '../utils/crypto.js';
import { nextCounter } from './counters.js';
import { adjustStock } from './stock.js';
import { enqueueSync } from '../sync/queue.js';
import { ValidationError } from '../utils/errors.js';

export type TransferItem = { variantId: string; qty: number; [k: string]: unknown };

export async function listTransfers(opts: { limit?: number } = {}) {
  return prisma.transfer.findMany({ orderBy: { datetime: 'desc' }, take: opts.limit ?? 500 });
}

// Crea una transferencia entre sucursales: mueve el stock de cada item y deja el
// registro (remito). El movimiento de stock es el mismo que /stock/transfer
// (skipTnSync + un push_stock por variante), así NO cambia cómo se sincroniza a TN.
export async function createTransfer(input: {
  fromBranch: string;
  toBranch: string;
  items: TransferItem[];
  notes?: string | null;
  userId?: string;
}) {
  const { fromBranch, toBranch, userId } = input;
  const items = (input.items || []).filter((i) => i.variantId && Number(i.qty) > 0);
  if (fromBranch === toBranch) throw new ValidationError('Origen y destino deben ser distintos');
  if (!items.length) throw new ValidationError('La transferencia no tiene items');

  const record = await prisma.$transaction(async (tx) => {
    for (const it of items) {
      const qty = Math.trunc(Number(it.qty));
      await adjustStock(it.variantId, fromBranch, -qty, { userId, reason: `Transfer to ${toBranch}`, skipTnSync: true, noNegative: true, tx });
      await adjustStock(it.variantId, toBranch, qty, { userId, reason: `Transfer from ${fromBranch}`, skipTnSync: true, tx });
    }
    const number = await nextCounter('transfer', tx);
    return tx.transfer.create({
      data: {
        id: randomId(),
        number,
        datetime: new Date(),
        fromBranch,
        toBranch,
        items: items as any,
        status: 'confirmed',
        notes: input.notes ?? null,
        userId: userId ?? null,
      },
    });
  });

  // Igual que la transferencia existente: encolar push_stock por variante.
  for (const it of items) await enqueueSync('push_stock', { variantId: it.variantId });
  return record;
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
