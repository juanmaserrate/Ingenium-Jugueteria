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

// Mensaje legible de un error de la API de Mercado Libre.
export function mlErrorText(err: any): string {
  const d = err?.response?.data;
  const causes: any[] = Array.isArray(d?.cause) ? d.cause : [];
  const errs = causes.filter((c) => c?.type !== 'warning').map((c) => c?.message || c?.code).filter(Boolean);
  const parts = [...new Set([...(errs.length ? errs : []), ...(errs.length ? [] : [d?.message, d?.error].filter(Boolean))].map((x) => String(x).trim()))];
  const status = err?.response?.status ? ` (${err.response.status})` : '';
  return (parts.join(' | ') || String(err?.message ?? 'Error desconocido')).slice(0, 400) + status;
}
