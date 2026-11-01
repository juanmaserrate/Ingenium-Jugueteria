import { prisma } from '../db.js';
import { requireMlClient } from './client.js';
import { computeMlStockForVariant } from '../services/stock.js';

// Handlers de sincronización HACIA Mercado Libre. Corren en el mismo worker/cola que TN
// (ver sync/worker.ts). Cada uno es idempotente: setea el valor absoluto, no incrementa.
export const mlSyncHandlers = {
  // Empuja la cantidad disponible absoluta de una variante a su publicación de ML.
  // Para publicaciones con variación, actualiza esa variación; si no, a nivel item.
  ml_push_stock: async (payload: { variantId: string }) => {
    const mapping = await prisma.variantMeliMapping.findUnique({ where: { variantId: payload.variantId } });
    if (!mapping) return { skipped: 'sin mapeo ML' };
    const qty = await computeMlStockForVariant(payload.variantId);
    const ml = await requireMlClient();
    if (mapping.mlVariationId) {
      await ml.updateItem(mapping.mlItemId, { variations: [{ id: Number(mapping.mlVariationId), available_quantity: qty }] });
    } else {
      await ml.updateItem(mapping.mlItemId, { available_quantity: qty });
    }
    await prisma.variantMeliMapping.update({ where: { variantId: payload.variantId }, data: { lastPushAt: new Date() } });
    return { itemId: mapping.mlItemId, variationId: mapping.mlVariationId ?? null, qty };
  },
};

export type MlSyncOperation = keyof typeof mlSyncHandlers;
