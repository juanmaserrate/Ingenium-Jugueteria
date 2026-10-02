// Backup lógico de la base de producción de Ingenium.
// Uso: desde backend/  ->  railway run --service Postgres node ../scripts/backup-db.mjs
// Vuelca TODAS las tablas a un JSON comprimido (.json.gz) en la carpeta backups/,
// y conserva los últimos KEEP backups (rota/borra los más viejos).
import { PrismaClient, Prisma } from '@prisma/client';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const OUT_DIR = process.env.BACKUP_DIR || 'C:/Users/Usuario/Desktop/Ingenium/backups';
const KEEP = Number(process.env.BACKUP_KEEP || 14); // cuántos backups conservar

const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!url) { console.error('[backup] FALTA DATABASE_PUBLIC_URL (correr con: railway run --service Postgres ...)'); process.exit(1); }

const prisma = new PrismaClient({ datasources: { db: { url } } });
const log = (m) => console.log(`[backup ${new Date().toISOString()}] ${m}`);

try {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const ts = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${ts.getFullYear()}${pad(ts.getMonth()+1)}${pad(ts.getDate())}_${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`;
  const outFile = path.join(OUT_DIR, `backup_ingenium_${stamp}.json.gz`);

  const models = Prisma.dmmf.datamodel.models.map((m) => m.name);
  const replacer = (_k, v) => (typeof v === 'bigint' ? v.toString() : v);

  const data = { _meta: { generatedAt: ts.toISOString(), source: 'railway-postgres', models: [] } };
  let total = 0;
  for (const model of models) {
    const delegate = prisma[model.charAt(0).toLowerCase() + model.slice(1)];
    if (!delegate || typeof delegate.findMany !== 'function') continue;
    try {
      const rows = await delegate.findMany();
      data[model] = rows;
      data._meta.models.push(model);
      total += rows.length;
    } catch (e) {
      log(`WARN ${model}: ${String(e?.message || e).slice(0,80)}`);
    }
  }

  // JSON -> gzip (stream, sin dejar el .json de 125MB en disco)
  const json = JSON.stringify(data, replacer);
  await pipeline(Readable.from(json), zlib.createGzip({ level: 9 }), fs.createWriteStream(outFile));
  const sizeMB = (fs.statSync(outFile).size / 1024 / 1024).toFixed(2);
  log(`OK ${path.basename(outFile)}  ${sizeMB}MB  ${data._meta.models.length} tablas  ${total} filas`);

  // Rotación: conservar solo los últimos KEEP .gz
  const files = fs.readdirSync(OUT_DIR)
    .filter((f) => /^backup_ingenium_.*\.json\.gz$/.test(f))
    .sort();
  const toDelete = files.slice(0, Math.max(0, files.length - KEEP));
  for (const f of toDelete) { fs.unlinkSync(path.join(OUT_DIR, f)); log(`rotado (borrado) ${f}`); }

  await prisma.$disconnect();
  process.exit(0);
} catch (e) {
  log(`ERROR ${String(e?.stack || e)}`);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
}
