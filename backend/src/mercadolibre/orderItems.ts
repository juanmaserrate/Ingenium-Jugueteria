import { prisma } from '../db.js';
import { getMlClient } from './client.js';
import { isValidGtin, relatedItemIds, itemGtin } from './pure.js';

// A qué producto del sistema corresponde un ítem de una ORDEN de Mercado Libre.
//
// El caso que rompía: en categorías de catálogo (libros, muchos juguetes de marca) ML crea
// sola una SEGUNDA publicación "de catálogo", sincronizada con la nuestra (comparte stock,
// garantía y condiciones). La venta puede entrar por cualquiera de las dos, y la de catálogo
// tiene otro id que el sistema no conoce → "ítem no vinculado a un producto".
// Se resuelve en este orden:
//   1) el id de la orden está vinculado (lo normal)
//   2) la publicación vendida declara con cuál está sincronizada (item_relations) y ESA está vinculada
//   3) el código de barras de la publicación coincide con el de UN solo producto del sistema

type Hit = { variantId: string; via: 'mapping' | 'catalog' | 'gtin'; linkedItemId: string | null; linkedVariationId: string | null };

async function byMapping(mlItemId: string, mlVariationId: string | null): Promise<{ variantId: string; mlVariationId: string | null } | null> {
  const maps = await prisma.variantMeliMapping.findMany({ where: { mlItemId } });
  if (!maps.length) return null;
  const hit = (mlVariationId && maps.find((m) => m.mlVariationId === String(mlVariationId)))
    || maps.find((m) => !m.mlVariationId) || (mlVariationId ? null : maps[0]);
  return hit ? { variantId: hit.variantId, mlVariationId: hit.mlVariationId ?? null } : null;
}

export async function resolveOrderItem(mlItemId: string, mlVariationId: string | null): Promise<Hit | null> {
  if (!mlItemId) return null;
  const direct = await byMapping(mlItemId, mlVariationId);
  if (direct) return { variantId: direct.variantId, via: 'mapping', linkedItemId: mlItemId, linkedVariationId: mlVariationId };

  // No está vinculada: se la lee en Mercado Libre para ver con cuál está sincronizada.
  const ml = await getMlClient().catch(() => null);
  if (!ml) return null;
  let item: any;
  try { item = await ml.getItem(mlItemId); } catch { return null; }

  for (const rel of relatedItemIds(item)) {
    const hit = await byMapping(rel.id, rel.variationId);
    if (hit) return { variantId: hit.variantId, via: 'catalog', linkedItemId: rel.id, linkedVariationId: hit.mlVariationId };
  }

  // Último recurso: código de barras real, si identifica a un único producto.
  const gtin = itemGtin(item);
  if (gtin && isValidGtin(gtin)) {
    const variants = await prisma.variant.findMany({
      where: { OR: [{ barcode: gtin }, { code: gtin }, { product: { code: gtin } }] },
      select: { id: true, barcode: true, code: true, product: { select: { code: true, _count: { select: { variants: true } } } }, mlMapping: { select: { mlItemId: true, mlVariationId: true } } },
    });
    // El código del PRODUCTO solo identifica a la variante cuando el producto tiene una sola.
    const exact = variants.filter((v) => v.barcode === gtin || v.code === gtin || (v.product.code === gtin && v.product._count.variants === 1));
    if (exact.length === 1) {
      const v = exact[0];
      return { variantId: v.id, via: 'gtin', linkedItemId: v.mlMapping?.mlItemId ?? null, linkedVariationId: v.mlMapping?.mlVariationId ?? null };
    }
  }
  return null;
}

// Para guardar la orden pendiente: si el ítem vendido es la publicación de catálogo, se anota
// con el id de la publicación vinculada (así la reserva de stock y la confirmación lo
// encuentran) y se conserva el id original en soldItemId.
export async function normalizeOrderItems<T extends { mlItemId: string; mlVariationId: string | null }>(items: T[]): Promise<Array<T & { soldItemId?: string }>> {
  const out: Array<T & { soldItemId?: string }> = [];
  for (const it of items) {
    try {
      const hit = await resolveOrderItem(it.mlItemId, it.mlVariationId);
      if (hit && hit.via !== 'mapping' && hit.linkedItemId) {
        out.push({ ...it, mlItemId: hit.linkedItemId, mlVariationId: hit.linkedVariationId, soldItemId: it.mlItemId });
        continue;
      }
    } catch { /* si falla la consulta, queda como vino */ }
    out.push(it);
  }
  return out;
}
