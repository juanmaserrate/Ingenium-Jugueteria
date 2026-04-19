import { prisma } from '../db.js';

export async function createConflict(type: string, payload: unknown) {
  return prisma.syncConflict.create({
    data: { type, payload: payload as any, status: 'open' },
  });
}

export async function listConflicts(status = 'open') {
  return prisma.syncConflict.findMany({
    where: { status },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
}

export async function resolveConflict(id: string, resolution: string, resolvedById?: string) {
  return prisma.syncConflict.update({
    where: { id },
    data: {
      status: 'resolved',
      resolution,
      resolvedById: resolvedById ?? null,
      resolvedAt: new Date(),
    },
  });
}

export async function dismissConflict(id: string, resolvedById?: string) {
  return prisma.syncConflict.update({
    where: { id },
    data: {
      status: 'dismissed',
      resolvedById: resolvedById ?? null,
      resolvedAt: new Date(),
    },
  });
}
