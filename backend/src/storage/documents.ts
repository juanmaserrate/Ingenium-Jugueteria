import { env } from '../config.js';
import { localDriver } from './drivers/local.js';
import { r2Driver } from './drivers/r2.js';
import { prisma } from '../db.js';
import { randomId } from '../utils/crypto.js';
import type { StorageDriver } from './images.js';

const driver: StorageDriver = env.STORAGE_DRIVER === 'r2' ? r2Driver : localDriver;

/**
 * Guarda un documento de compra (factura PDF/imagen) en el storage y crea el
 * registro PurchaseDocument. A diferencia de saveProductImage, NO encola nada
 * hacia Tienda Nube: estos archivos son internos.
 */
export async function savePurchaseDocument(
  purchaseId: string,
  data: Buffer,
  contentType: string,
  filename: string,
) {
  const extFromName = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : '';
  const ext = extFromName || (contentType === 'application/pdf' ? 'pdf' : 'bin');
  const key = `purchases/${purchaseId}/${randomId()}.${ext}`;
  const { url } = await driver.save(key, data, contentType);

  return prisma.purchaseDocument.create({
    data: {
      id: randomId(),
      purchaseId,
      storageKey: key,
      url,
      contentType,
      filename,
    },
  });
}

/** Lee el buffer de un documento ya guardado (para mandarlo a Claude en el scan). */
export async function getPurchaseDocumentBuffer(storageKey: string): Promise<Buffer> {
  return driver.getBuffer(storageKey);
}
