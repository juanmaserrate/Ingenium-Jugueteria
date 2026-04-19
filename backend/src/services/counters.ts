import { prisma } from '../db.js';

export async function nextCounter(name: string): Promise<number> {
  const updated = await prisma.$transaction(async (tx) => {
    const existing = await tx.counter.findUnique({ where: { name } });
    if (!existing) {
      await tx.counter.create({ data: { name, value: 1 } });
      return 1;
    }
    const next = existing.value + 1;
    await tx.counter.update({ where: { name }, data: { value: next } });
    return next;
  });
  return updated;
}

export async function nextYearlyCounter(name: string, refDate = new Date()): Promise<number> {
  const year = refDate.getFullYear();
  const key = `${name}_${year}`;
  return nextCounter(key);
}
