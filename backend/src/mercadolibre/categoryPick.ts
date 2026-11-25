import { requireMlClient } from './client.js';
import { chooseSpecificCategory, isGenericCategory, type CatCandidate } from './massPure.js';

// Elegir una categoría ESPECÍFICA de Mercado Libre para un producto que hoy cae en una
// genérica ("… > Otros"). La predicción de ML por el nombre solo, sin contexto, manda cosas a
// rubros que no tienen nada que ver (medido 2026-11-25: "Encastres dobles" → Herrajes >
// Bisagras; "Espuma de baño" → Limpieza de PCs). Por eso solo se acepta una sugerencia que
// esté en la MISMA RAMA que la categoría genérica (mismo padre si se puede; si no, mismo rubro
// raíz). Si no hay ninguna, no se elige nada: mejor a mano que mal categorizado.

const SITE = 'MLA';
type CatInfo = { pathIds: string[]; pathNames: string[] };
const cats = new Map<string, CatInfo>(); // el árbol de categorías de ML no cambia en el día

async function catInfo(id: string): Promise<CatInfo | null> {
  if (!id) return null;
  const hit = cats.get(id);
  if (hit) return hit;
  try {
    const ml = await requireMlClient();
    const c: any = await ml.getCategory(id);
    const path: any[] = Array.isArray(c?.path_from_root) ? c.path_from_root : [];
    const info = { pathIds: path.map((x) => String(x.id)), pathNames: path.map((x) => String(x.name)) };
    if (info.pathIds.length) cats.set(id, info);
    return info.pathIds.length ? info : null;
  } catch { return null; }
}

export async function categoryPath(id: string): Promise<string> {
  return (await catInfo(id))?.pathNames.join(' > ') || id;
}

export async function pickSpecificCategory(genericCategoryId: string, title: string): Promise<{ categoryId: string; path: string } | null> {
  const anchor = await catInfo(genericCategoryId);
  if (!anchor || anchor.pathIds.length < 2) return null;
  const parentIds = anchor.pathIds.slice(0, -1);
  const parentName = anchor.pathNames[anchor.pathNames.length - 2];
  const name = String(title || '').slice(0, 60).trim();
  if (!name) return null;
  const ml = await requireMlClient();
  // El nombre solo, y el nombre con el rubro adelante (le da contexto a la predicción).
  const queries = [...new Set([name, `${parentName} ${name}`.slice(0, 90)])];
  const cands: CatCandidate[] = [];
  const seen = new Set<string>();
  for (const q of queries) {
    let preds: any[] = [];
    try { const res = await ml.predictCategory(SITE, q, 8); preds = Array.isArray(res) ? res : []; } catch { /* sin sugerencias para esa búsqueda */ }
    for (const p of preds) {
      const id = String(p?.category_id ?? '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const info = await catInfo(id);
      if (info) cands.push({ categoryId: id, pathIds: info.pathIds, pathNames: info.pathNames });
    }
  }
  const best = chooseSpecificCategory(parentIds, cands);
  return best ? { categoryId: best.categoryId, path: best.pathNames.join(' > ') } : null;
}

// Categorías específicas que sugiere ML para un nombre (sin filtrar por rama), para que una
// persona elija. Las genéricas ("Otros") se descartan.
export async function categoryCandidates(title: string, n = 4): Promise<Array<{ categoryId: string; path: string }>> {
  const name = String(title || '').slice(0, 60).trim();
  if (!name) return [];
  const ml = await requireMlClient();
  let preds: any[] = [];
  try { const res = await ml.predictCategory(SITE, name, 8); preds = Array.isArray(res) ? res : []; } catch { return []; }
  const out: Array<{ categoryId: string; path: string }> = [];
  for (const p of preds) {
    const id = String(p?.category_id ?? '');
    if (!id || out.some((o) => o.categoryId === id)) continue;
    const info = await catInfo(id);
    if (!info || isGenericCategory(info.pathNames[info.pathNames.length - 1])) continue;
    out.push({ categoryId: id, path: info.pathNames.join(' > ') });
    if (out.length >= n) break;
  }
  return out;
}

// Igual que categoryCandidates, y además avisa si lo PRIMERO que sugiere ML es una categoría
// genérica ("Otros"): señal de que para ML ese producto no tiene una específica.
export async function categoryCandidatesInfo(title: string, n = 3): Promise<{ topGeneric: boolean; candidates: Array<{ categoryId: string; path: string }> }> {
  const name = String(title || '').slice(0, 60).trim();
  if (!name) return { topGeneric: false, candidates: [] };
  const ml = await requireMlClient();
  let preds: any[] = [];
  try { const res = await ml.predictCategory(SITE, name, 8); preds = Array.isArray(res) ? res : []; } catch { return { topGeneric: false, candidates: [] }; }
  const out: Array<{ categoryId: string; path: string }> = [];
  let topGeneric = false;
  let first = true;
  for (const p of preds) {
    const id = String(p?.category_id ?? '');
    if (!id || out.some((o) => o.categoryId === id)) continue;
    const info = await catInfo(id);
    if (!info) continue;
    const generic = isGenericCategory(info.pathNames[info.pathNames.length - 1]);
    if (first) { topGeneric = generic; first = false; }
    if (generic) continue;
    out.push({ categoryId: id, path: info.pathNames.join(' > ') });
    if (out.length >= n) break;
  }
  return { topGeneric, candidates: out };
}
