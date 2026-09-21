import { prisma } from '../db.js';
import type { Prisma } from '@prisma/client';

// Numeración atómica: un solo upsert con increment en la base evita el "lost update"
// (dos requests concurrentes NO pueden obtener el mismo número). Acepta un `tx` para
// correr dentro de la transacción de la venta/compra (si esa falla, no queda hueco).
export async function nextCounter(name: string, tx?: Prisma.TransactionClient): Promise<number> {
  const client = tx ?? prisma;
  const c = await client.counter.upsert({
    where: { name },
    create: { name, value: 1 },
    update: { value: { increment: 1 } },
  });
  return c.value;
}

export async function nextYearlyCounter(name: string, refDate = new Date(), tx?: Prisma.TransactionClient): Promise<number> {
  const year = refDate.getFullYear();
  const key = `${name}_${year}`;
  return nextCounter(key, tx);
}
