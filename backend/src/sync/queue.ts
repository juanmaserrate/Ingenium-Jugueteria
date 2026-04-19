import { prisma } from '../db.js';

export async function enqueueSync(operation: string, payload: Record<string, unknown>) {
  // Deduplicaci\u00f3n: si ya hay una operaci\u00f3n igual "queued" para el mismo variant/product,
  // no agregamos otra (evita spam cuando se hacen varias operaciones seguidas).
  if (operation === 'push_stock' && typeof payload.variantId === 'string') {
    const existing = await prisma.syncQueue.findFirst({
      where: { operation, status: 'queued', payload: { equals: payload as any } },
    });
    if (existing) return existing;
  }
  return prisma.syncQueue.create({
    data: {
      operation,
      payload: payload as any,
      status: 'queued',
      nextRunAt: new Date(),
    },
  });
}

export async function takeNextJobs(limit = 10) {
  const now = new Date();
  const jobs = await prisma.syncQueue.findMany({
    where: { status: 'queued', nextRunAt: { lte: now } },
    orderBy: { nextRunAt: 'asc' },
    take: limit,
  });
  if (jobs.length === 0) return [];
  await prisma.syncQueue.updateMany({
    where: { id: { in: jobs.map((j) => j.id) } },
    data: { status: 'running' },
  });
  return jobs;
}

export async function markDone(id: string) {
  await prisma.syncQueue.update({
    where: { id },
    data: { status: 'done', doneAt: new Date() },
  });
}

export async function markFailed(id: string, error: string, maxRetries: number) {
  const job = await prisma.syncQueue.findUnique({ where: { id } });
  if (!job) return;
  const attempts = job.attempts + 1;
  const shouldRetry = attempts < maxRetries;
  await prisma.syncQueue.update({
    where: { id },
    data: {
      status: shouldRetry ? 'queued' : 'failed',
      attempts,
      lastError: error,
      nextRunAt: shouldRetry ? new Date(Date.now() + backoff(attempts)) : new Date(),
    },
  });
}

function backoff(attempt: number): number {
  // exp backoff: 5s, 30s, 2min, 10min, 1h
  return Math.min(60 * 60 * 1000, 5000 * Math.pow(5, attempt - 1));
}

export async function listJobs(status?: string) {
  return prisma.syncQueue.findMany({
    where: status ? { status } : undefined,
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
}
