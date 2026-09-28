import { prisma } from '../db.js';

// Devuelve todas las settings como un objeto { key: value }.
export async function getAllSettings(): Promise<Record<string, unknown>> {
  const rows = await prisma.setting.findMany();
  const out: Record<string, unknown> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export async function getSetting(key: string) {
  const row = await prisma.setting.findUnique({ where: { key } });
  return row ? row.value : null;
}

export async function setSetting(key: string, value: unknown) {
  const row = await prisma.setting.upsert({
    where: { key },
    create: { key, value: value as any },
    update: { value: value as any },
  });
  return row.value;
}
