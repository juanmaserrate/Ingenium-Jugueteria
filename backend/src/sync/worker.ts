import { env } from '../config.js';
import { prisma } from '../db.js';
import { takeNextJobs, markDone, markFailed } from './queue.js';
import { syncHandlers, type SyncOperation } from '../tiendanube/sync.js';
import type { FastifyBaseLogger } from 'fastify';

let running = false;

export function startSyncWorker(log: FastifyBaseLogger) {
  if (running) return;
  running = true;

  const tick = async () => {
    try {
      const integration = await prisma.integration.findUnique({ where: { provider: 'tiendanube' } });
      if (!integration?.active) {
        setTimeout(tick, env.SYNC_WORKER_INTERVAL_MS);
        return;
      }
      const jobs = await takeNextJobs(10);
      for (const job of jobs) {
        const op = job.operation as SyncOperation;
        const handler = syncHandlers[op];
        if (!handler) {
          await markFailed(job.id, `Unknown operation: ${op}`, env.SYNC_MAX_RETRIES);
          continue;
        }
        try {
          const result = await handler(job.payload as any);
          await prisma.tnSyncLog.create({
            data: {
              operation: op,
              entity: inferEntity(op),
              entityId: (job.payload as any)?.variantId ?? (job.payload as any)?.productId ?? null,
              status: 'success',
              attempt: job.attempts + 1,
              payload: job.payload as any,
              response: result as any,
            },
          });
          await markDone(job.id);
        } catch (err: any) {
          const msg = err?.response?.data ? JSON.stringify(err.response.data) : err?.message ?? String(err);
          log.error({ op, err: msg }, 'sync job failed');
          await prisma.tnSyncLog.create({
            data: {
              operation: op,
              entity: inferEntity(op),
              entityId: (job.payload as any)?.variantId ?? (job.payload as any)?.productId ?? null,
              status: 'error',
              attempt: job.attempts + 1,
              error: msg,
              payload: job.payload as any,
            },
          });
          await markFailed(job.id, msg, env.SYNC_MAX_RETRIES);
        }
      }
    } catch (err) {
      log.error({ err }, 'sync worker tick error');
    }
    setTimeout(tick, env.SYNC_WORKER_INTERVAL_MS);
  };

  setTimeout(tick, env.SYNC_WORKER_INTERVAL_MS);
  log.info('Sync worker started');
}

function inferEntity(op: string): string {
  if (op.includes('product')) return 'product';
  if (op.includes('variant')) return 'variant';
  if (op.includes('stock')) return 'stock';
  if (op.includes('image')) return 'image';
  if (op.includes('order')) return 'order';
  return 'unknown';
}
