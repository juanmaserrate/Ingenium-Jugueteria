// S-5: export/import completo de IndexedDB como JSON.
// Uso:
//   const blob = await exportBackup();  → dispara descarga
//   await importBackup(file, { wipe: true });  → restaura desde archivo
//
// El formato es:
//   { version: 1, exported_at, app: 'ingenium', stores: { [name]: [records] } }

import { openDB, put, getAll } from './db.js';
import { STORES } from './schema.js';
import { log, AUDIT_ACTIONS } from './audit.js';

const FILE_VERSION = 1;
const APP = 'ingenium';

export async function exportBackup({ download = true } = {}) {
  const data = { version: FILE_VERSION, app: APP, exported_at: new Date().toISOString(), stores: {} };
  for (const def of STORES) {
    try {
      data.stores[def.name] = await getAll(def.name);
    } catch (e) {
      console.warn(`backup: skip ${def.name}`, e);
      data.stores[def.name] = [];
    }
  }
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  if (download) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href = url; a.download = `ingenium-backup-${ts}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  try {
    await log({
      action: AUDIT_ACTIONS.BACKUP_EXPORT, entity: 'settings', entity_id: null,
      description: `Backup exportado (${Object.keys(data.stores).length} stores, ${blob.size} bytes)`,
    });
  } catch {}
  return { blob, data };
}

export async function importBackup(fileOrText, { wipe = false } = {}) {
  const text = typeof fileOrText === 'string' ? fileOrText : await fileOrText.text();
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new Error('JSON inválido'); }
  if (parsed.app !== APP) throw new Error(`Archivo no reconocido (app=${parsed.app})`);
  if (!parsed.stores || typeof parsed.stores !== 'object') throw new Error('Formato inválido: falta "stores"');

  const db = await openDB();
  const storeNames = STORES.map(s => s.name).filter(n => parsed.stores[n]);

  if (wipe) {
    await new Promise((res, rej) => {
      const tx = db.transaction(storeNames, 'readwrite');
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      for (const name of storeNames) tx.objectStore(name).clear();
    });
  }

  let imported = 0;
  for (const name of storeNames) {
    const records = parsed.stores[name] || [];
    for (const rec of records) {
      try { await put(name, rec); imported++; }
      catch (e) { console.warn(`restore: fallo ${name}`, e); }
    }
  }

  try {
    await log({
      action: AUDIT_ACTIONS.BACKUP_IMPORT, entity: 'settings', entity_id: null,
      description: `Backup importado (${imported} registros, wipe=${wipe})`,
    });
  } catch {}

  return { imported, stores: storeNames.length };
}

// Recordatorio automático: si pasó más de N días desde el último backup,
// dispara un toast al cargar la app. Llamalo una vez en app.html.
export async function checkBackupReminder({ maxDaysKey = 'ingenium_last_backup_at', days = 7 } = {}) {
  try {
    const lastRaw = localStorage.getItem(maxDaysKey);
    const last = lastRaw ? new Date(lastRaw).getTime() : 0;
    const ms = Date.now() - last;
    const msWarn = days * 24 * 60 * 60 * 1000;
    return { dueBackup: !last || ms > msWarn, lastAt: last ? new Date(last).toISOString() : null, daysSince: last ? Math.floor(ms / 86400000) : null };
  } catch { return { dueBackup: false, lastAt: null, daysSince: null }; }
}

export function markBackupNow(key = 'ingenium_last_backup_at') {
  try { localStorage.setItem(key, new Date().toISOString()); } catch {}
}
