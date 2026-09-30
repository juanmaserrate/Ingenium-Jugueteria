import { env } from '../config.js';
import { prisma } from '../db.js';
import { takeNextJobs, markDone, markFailed, reapStuckJobs } from './queue.js';
import { syncHandlers, type SyncOperation } from '../tiendanube/sync.js';
import type { FastifyBaseLogger } from 'fastify';

let running = false;

// Al arrancar el proceso (típicamente tras un redeploy de Railway), recupera el
// estado que pudo quedar a medias: jobs de sync huérfanos en 'running' y órdenes de
// TN atascadas en 'assigning' (un assign que se cortó entre reclamar la orden y crear
// la venta). Ambos se vuelven a su estado tomable ('queued' / 'pending').
async function recoverOnBoot(log: FastifyBaseLogger) {
  try {
    const reaped = await reapStuckJobs(0); // 0 = re-encola TODOS los running (son huérfanos al bootear)
    const assigning = await prisma.tnOrderPending.updateMany({
      where: { status: 'assigning' },
      data: { status: 'pending' },
    });
    if (reaped || assigning.count) {
      log.warn({ reapedJobs: reaped, resetAssigningOrders: assigning.count }, 'sync worker boot recovery');
    }
  } catch (err) {
    log.error({ err }, 'sync worker boot recovery failed');
  }
}

export function startSyncWorker(log: FastifyBaseLogger) {
  if (running) return;
  running = true;

  void recoverOnBoot(log);

  const tick = async () => {
    try {
      const integration = await prisma.integration.findUnique({ where: { provider: 'tiendanube' } });
      if (!integration?.active) {
        setTimeout(tick, env.SYNC_WORKER_INTERVAL_MS);
        return;
      }
      // Reaper periódico: recupera jobs cuya lease venció (un handler que se colgó o
      // un huérfano que quedó sin bootear). Barato (un updateMany indexado por status).
      const reaped = await reapStuckJobs(env.SYNC_JOB_LEASE_MS);
      if (reaped) log.warn({ reaped }, 'sync reaper re-encoló jobs con lease vencida');
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
