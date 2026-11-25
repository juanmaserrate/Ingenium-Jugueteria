import type { AuditRow } from './massPure.js';

// Lógica pura de los arreglos de publicaciones (sin red ni base): qué publicaciones entran en
// cada acción y qué datos le faltan a una publicación para pasar a otra categoría.

export type RepairAction = 'reactivate' | 'recategorize' | 'republish';

// Publicaciones de la auditoría que corresponden a cada arreglo.
export function repairTargets(rows: AuditRow[], action: RepairAction): AuditRow[] {
  if (action === 'reactivate') return rows.filter((r) => r.status === 'paused' && r.subStatus.includes('picture_download_pending'));
  if (action === 'recategorize') return rows.filter((r) => r.genericCategory && !r.finalized && (r.status === 'active' || r.status === 'paused'));
  return rows.filter((r) => r.finalized);
}

const isRequired = (a: any) => !!(a?.tags && (a.tags.required || a.tags.catalog_required || a.tags.fixed));

// Datos obligatorios de la categoría nueva que la publicación no tiene:
//   fill     → se pueden completar solos (marca del producto, o el nombre en los de texto libre)
//   blocking → hay que elegirlos de una lista (ej. "Género"): sin ese dato no se puede pasar
export function missingForCategory(
  schema: any[] | null | undefined,
  itemAttributes: any[] | null | undefined,
  known: { title: string; brand?: string | null },
): { fill: Array<{ id: string; value_name: string }>; blocking: string[] } {
  const have = new Set((itemAttributes || []).filter((a) => a && (a.value_name != null && a.value_name !== '' || a.value_id != null)).map((a) => String(a.id)));
  const fill: Array<{ id: string; value_name: string }> = [];
  const blocking: string[] = [];
  for (const a of schema || []) {
    if (!a?.id || !isRequired(a) || have.has(a.id) || /^SELLER_PACKAGE_/.test(a.id)) continue;
    if (a.id === 'GTIN' || a.id === 'EMPTY_GTIN_REASON') continue; // ya se resolvió al publicar
    if (a.id === 'BRAND' && known.brand) { fill.push({ id: 'BRAND', value_name: known.brand }); continue; }
    const openText = (a.value_type === 'string' || a.value_type === 'text') && !(a.values && a.values.length) && !a.allowed_units;
    if (openText && known.title) fill.push({ id: a.id, value_name: known.title });
    else blocking.push(String(a.name || a.id));
  }
  return { fill, blocking };
}

// --- Fotos chicas ---
// Mercado Libre no termina de aceptar una foto si su lado más largo mide menos de 500 px: la
// publicación queda pausada "esperando las fotos" para siempre (medido 2026-11-24: las 171
// pausadas tenían al menos una así, y ninguna de las activas). Qué se hace con cada foto:
//   keep    → sirve como está
//   upscale → se agranda (hasta el doble) y se vuelve a subir
//   drop    → demasiado chica para agrandarla sin que quede borrosa: se quita
export const MIN_PICTURE_SIDE = 500;
export const UPSCALE_TO = 600;      // lado más largo de la foto agrandada
export const MAX_UPSCALE = 2;       // no agrandar más del doble

export type PicturePlan = { id: string; w: number; h: number; action: 'keep' | 'upscale' | 'drop' };

export function planPictures(pics: Array<{ id: string; size?: string | null }> | null | undefined): PicturePlan[] {
  return (pics || []).map((p) => {
    const m = /^(\d+)x(\d+)$/.exec(String(p.size ?? '').trim());
    const w = m ? Number(m[1]) : 0;
    const h = m ? Number(m[2]) : 0;
    const longest = Math.max(w, h);
    // Sin medida conocida no se toca.
    const action: PicturePlan['action'] = !longest || longest >= MIN_PICTURE_SIDE ? 'keep'
      : longest * MAX_UPSCALE >= UPSCALE_TO ? 'upscale' : 'drop';
    return { id: String(p.id), w, h, action };
  });
}

// Mensaje legible de un error de la API de Mercado Libre.
export function mlErrorText(err: any): string {
  const d = err?.response?.data;
  const causes: any[] = Array.isArray(d?.cause) ? d.cause : [];
  const errs = causes.filter((c) => c?.type !== 'warning').map((c) => c?.message || c?.code).filter(Boolean);
  const parts = [...new Set([...(errs.length ? errs : []), ...(errs.length ? [] : [d?.message, d?.error].filter(Boolean))].map((x) => String(x).trim()))];
  const status = err?.response?.status ? ` (${err.response.status})` : '';
  return (parts.join(' | ') || String(err?.message ?? 'Error desconocido')).slice(0, 400) + status;
}
