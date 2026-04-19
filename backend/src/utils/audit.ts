import { prisma } from '../db.js';
import { randomId, sha256 } from './crypto.js';

export const AUDIT_ACTIONS = {
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  SALE_CONFIRMED: 'sale_confirmed',
  SALE_CANCELLED: 'sale_cancelled',
  RETURN_PROCESSED: 'return_processed',
  STOCK_ADJUSTED: 'stock_adjusted',
  TN_CONNECTED: 'tn_connected',
  TN_DISCONNECTED: 'tn_disconnected',
  TN_SYNC: 'tn_sync',
} as const;

export async function logAudit(entry: {
  userId?: string;
  action: string;
  entity: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  description?: string;
}): Promise<void> {
  const last = await prisma.auditLog.findFirst({ orderBy: { datetime: 'desc' } });
  const prevHash = last?.hash ?? null;
  const payload = JSON.stringify({ ...entry, prevHash, ts: Date.now() });
  const hash = sha256(payload);
  await prisma.auditLog.create({
    data: {
      id: randomId(),
      userId: entry.userId ?? null,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId ?? null,
      before: (entry.before ?? null) as any,
      after: (entry.after ?? null) as any,
      description: entry.description ?? null,
      hash,
      prevHash,
    },
  });
}
