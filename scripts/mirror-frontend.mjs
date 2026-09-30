#!/usr/bin/env node
// Espeja el frontend (código fuente en la raíz del repo) hacia backend/public, que es
// lo que el backend sirve en producción. Se corre solo en cada commit (pre-commit hook)
// y también a mano con `npm run mirror`. Evita el drift manual src ↔ backend/public.
//
// Copia byte a byte (para que queden idénticos) y BORRA en el destino los archivos que ya
// no existan en el origen. Idempotente: si no hay cambios, no toca nada.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEST = path.join(ROOT, 'backend', 'public');

// Qué se espeja: archivos sueltos + carpetas (recursivas).
const FILES = ['app.html', 'index.html', 'sw.js'];
const DIRS = ['src', 'assets'];

let copied = 0;
let deleted = 0;

async function sameBytes(a, b) {
  try {
    const [ba, bb] = await Promise.all([fs.readFile(a), fs.readFile(b)]);
    return ba.equals(bb);
  } catch {
    return false;
  }
}

async function copyFile(src, dest) {
  if (await sameBytes(src, dest)) return;
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(src, dest);
  copied++;
}

async function listFiles(dir) {
  const out = [];
  async function walk(d, rel) {
    let entries;
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      const r = path.join(rel, e.name);
      if (e.isDirectory()) await walk(full, r);
      else out.push(r);
    }
  }
  await walk(dir, '');
  return out;
}

async function syncDir(name) {
  const srcDir = path.join(ROOT, name);
  const destDir = path.join(DEST, name);
  const srcFiles = new Set(await listFiles(srcDir));
  // Copiar/actualizar
  for (const rel of srcFiles) {
    await copyFile(path.join(srcDir, rel), path.join(destDir, rel));
  }
  // Borrar en destino lo que ya no existe en origen
  for (const rel of await listFiles(destDir)) {
    if (!srcFiles.has(rel)) {
      await fs.rm(path.join(destDir, rel));
      deleted++;
    }
  }
}

for (const f of FILES) {
  const src = path.join(ROOT, f);
  try { await fs.access(src); } catch { continue; }
  await copyFile(src, path.join(DEST, f));
}
for (const d of DIRS) await syncDir(d);

if (copied || deleted) console.log(`[mirror] backend/public actualizado: ${copied} copiados, ${deleted} borrados`);
else console.log('[mirror] backend/public ya estaba en sync');
