import { prisma } from '../db.js';
import { requireMlClient } from './client.js';

// Condiciones de venta de la tienda que llevan TODAS las publicaciones:
//  - Garantía del vendedor de 30 días
//  - Retiro en persona (además del envío)
// Se aplican al publicar y, con applyStoreTermsToItem, a publicaciones que ya existen.

export { WARRANTY_DAYS, STORE_SALE_TERMS, mergeWarrantyTerms } from './pure.js';
import { mergeWarrantyTerms } from './pure.js';

const errMsg = (e: any) => {
  const d = e?.response?.data;
  const cause = Array.isArray(d?.cause) ? d.cause.map((c: any) => c?.message || c?.code).filter(Boolean).join(' · ') : '';
  return cause || d?.message || d?.error || e?.message || 'error';
};

// Aplica garantía + retiro en persona a UNA publicación. Cada cosa por separado para que el
// rechazo de una no frene la otra. No toca precio, stock ni título.
export async function applyStoreTermsToItem(itemId: string, mlIn?: any, itemIn?: any) {
  const ml = mlIn ?? (await requireMlClient());
  const out: { itemId: string; warranty: string; pickup: string; error?: string } = { itemId, warranty: 'sin cambios', pickup: 'sin cambios' };
  let item = itemIn;
  if (!item) {
    try { item = await ml.getItem(itemId); }
    catch (e) { return { ...out, warranty: 'error', pickup: 'error', error: errMsg(e) }; }
  }
  if (item?.status === 'closed') return { ...out, warranty: 'cerrada', pickup: 'cerrada' };

  const terms = mergeWarrantyTerms(item?.sale_terms);
  if (terms) {
    try { await ml.updateItem(itemId, { sale_terms: terms }); out.warranty = 'aplicada'; }
    catch (e) { out.warranty = 'error'; out.error = errMsg(e); }
  }

  if (item?.shipping?.local_pick_up !== true) {
    try {
      const shipping: any = { local_pick_up: true };
      if (item?.shipping?.mode) shipping.mode = item.shipping.mode;
      if (typeof item?.shipping?.free_shipping === 'boolean') shipping.free_shipping = item.shipping.free_shipping;
      await ml.updateItem(itemId, { shipping });
      out.pickup = 'aplicado';
    } catch (e) {
      out.pickup = 'error';
      out.error = [out.error, errMsg(e)].filter(Boolean).join(' | ');
    }
  }
  return out;
}

// Publicaciones vinculadas al inventario (ids únicos).
export async function linkedItemIds(): Promise<string[]> {
  const maps = await prisma.variantMeliMapping.findMany({ select: { mlItemId: true } });
  return [...new Set(maps.map((m) => m.mlItemId))];
}
