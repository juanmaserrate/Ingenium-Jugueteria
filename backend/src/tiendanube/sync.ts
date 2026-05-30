import { prisma } from '../db.js';
import { getTnClient } from './client.js';
import { productToTn, variantToTn } from './mappers.js';
import { computeTnStockForVariant } from '../services/stock.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config.js';

/**
 * Handlers de cada operaci\u00f3n de sync. El worker delega ac\u00e1 seg\u00fan el tipo.
 */
export const syncHandlers = {
  async push_product_create(payload: { productId: string }) {
    const tn = await getTnClient();
    if (!tn) throw new Error('TN not connected');
    const product = await prisma.product.findUnique({
      where: { id: payload.productId },
      include: { variants: true, images: true, tnMapping: true },
    });
    if (!product) throw new Error(`Product ${payload.productId} not found`);
    if (product.tnMapping) return { skipped: 'already synced' };

    const tnProduct = await tn.createProduct(productToTn(product));
    await prisma.productTnMapping.create({
      data: {
        productId: product.id,
        tnProductId: String(tnProduct.id),
        lastPushAt: new Date(),
      },
    });
    // Mapear variantes
    const tnVariants: any[] = tnProduct.variants ?? [];
    for (let i = 0; i < product.variants.length && i < tnVariants.length; i++) {
      await prisma.variantTnMapping.create({
        data: {
          variantId: product.variants[i].id,
          tnProductId: String(tnProduct.id),
          tnVariantId: String(tnVariants[i].id),
          lastPushAt: new Date(),
        },
      });
    }
    // Subir im\u00e1genes via push_image_create (un solo path robusto: URL con fallback
    // a base64 + idempotencia + reintentos autom\u00e1ticos). Antes este loop sub\u00eda
    // inline con .catch silencioso y sin fallback, as\u00ed que si STORAGE_PUBLIC_URL no
    // era accesible desde TN, las im\u00e1genes se perd\u00edan en silencio.
    const { enqueueSync } = await import('../sync/queue.js');
    for (const img of product.images) {
      if (img.tnImageId) continue; // ya subida, idempotente
      await enqueueSync('push_image_create', { productId: product.id, imageId: img.id });
    }
    // Push stock inicial
    for (const v of product.variants) {
      await syncHandlers.push_stock({ variantId: v.id });
    }
    return { tnProductId: tnProduct.id };
  },

  async push_product_update(payload: { productId: string }) {
    const tn = await getTnClient();
    if (!tn) throw new Error('TN not connected');
    const product = await prisma.product.findUnique({
      where: { id: payload.productId },
      include: { variants: true, tnMapping: true },
    });
    if (!product) throw new Error(`Product ${payload.productId} not found`);
    if (!product.tnMapping) return syncHandlers.push_product_create(payload);
    await tn.updateProduct(product.tnMapping.tnProductId, {
      name: { es: product.name },
      description: product.description ? { es: product.description } : undefined,
      published: product.active,
    });
    await prisma.productTnMapping.update({
      where: { productId: product.id },
      data: { lastPushAt: new Date() },
    });
    return { ok: true };
  },

  async push_product_delete(payload: { productId: string; tnProductId: string }) {
    const tn = await getTnClient();
    if (!tn) throw new Error('TN not connected');
    await tn.deleteProduct(payload.tnProductId).catch(() => null);
    return { ok: true };
  },

  async push_variant_create(payload: { variantId: string }) {
    const tn = await getTnClient();
    if (!tn) throw new Error('TN not connected');
    const variant = await prisma.variant.findUnique({
      where: { id: payload.variantId },
      include: { product: { include: { tnMapping: true } } },
    });
    if (!variant || !variant.product.tnMapping) return { skipped: 'product not on TN' };
    const tnVariant = await tn.createVariant(
      variant.product.tnMapping.tnProductId,
      variantToTn(variant, variant.product.price, variant.product.cost),
    );
    await prisma.variantTnMapping.create({
      data: {
        variantId: variant.id,
        tnProductId: variant.product.tnMapping.tnProductId,
        tnVariantId: String(tnVariant.id),
        lastPushAt: new Date(),
      },
    });
    await syncHandlers.push_stock({ variantId: variant.id });
    return { tnVariantId: tnVariant.id };
  },

  async push_variant_update(payload: { variantId: string }) {
    const tn = await getTnClient();
    if (!tn) throw new Error('TN not connected');
    const variant = await prisma.variant.findUnique({
      where: { id: payload.variantId },
      include: { product: true, tnMapping: true },
    });
    if (!variant || !variant.tnMapping) return { skipped: 'no mapping' };
    await tn.updateVariant(
      variant.tnMapping.tnProductId,
      variant.tnMapping.tnVariantId,
      variantToTn(variant, variant.product.price, variant.product.cost),
    );
    await prisma.variantTnMapping.update({
      where: { variantId: variant.id },
      data: { lastPushAt: new Date() },
    });
    return { ok: true };
  },

  async push_variant_delete(payload: { tnProductId: string; tnVariantId: string }) {
    const tn = await getTnClient();
    if (!tn) throw new Error('TN not connected');
    await tn.deleteVariant(payload.tnProductId, payload.tnVariantId).catch(() => null);
    return { ok: true };
  },

  async push_stock(payload: { variantId: string }) {
    const tn = await getTnClient();
    if (!tn) throw new Error('TN not connected');
    const mapping = await prisma.variantTnMapping.findUnique({ where: { variantId: payload.variantId } });
    if (!mapping) return { skipped: 'no mapping' };
    const qty = await computeTnStockForVariant(payload.variantId);
    await tn.updateVariant(mapping.tnProductId, mapping.tnVariantId, {
      stock: qty,
      stock_management: true,
    });
    await prisma.variantTnMapping.update({
      where: { variantId: payload.variantId },
      data: { lastPushAt: new Date() },
    });
    return { variantId: payload.variantId, newStock: qty };
  },

  async push_image_create(payload: { productId: string; imageId: string }) {
    const tn = await getTnClient();
    if (!tn) throw new Error('TN not connected');
    const product = await prisma.product.findUnique({
      where: { id: payload.productId },
      include: { tnMapping: true },
    });
    const image = await prisma.productImage.findUnique({ where: { id: payload.imageId } });
    // Diferenciamos casos: si el image/product fue borrado, skip definitivo.
    // Si falta tnMapping → push_product_create todavía no corrió → THROW para que la queue
    // reintente con backoff. Antes esto era un skip silencioso que perdía las imágenes
    // subidas en paralelo a la creación del producto.
    if (!image) return { skipped: 'image deleted' };
    if (!product) return { skipped: 'product deleted' };
    if (!product.tnMapping) {
      throw new Error('Product tnMapping not ready yet — retrying');
    }
    if (image.tnImageId) return { skipped: 'already uploaded', tnImageId: image.tnImageId };
    // TN exige position >= 1 (la nuestra arranca en 0). Sumamos 1 al pushar.
    const tnPos = (image.position ?? 0) + 1;
    // El filename es requerido cuando se manda attachment. Lo derivamos del storageKey.
    const filename = path.basename(image.storageKey);
    // Preferimos enviar URL p\u00fablica; fallback attachment base64 si la URL no es alcanzable
    // desde TN o si TN rechaza el src.
    let resp: any;
    try {
      resp = await tn.uploadImage(product.tnMapping.tnProductId, {
        src: image.url,
        filename,
        position: tnPos,
      });
    } catch {
      // Fallback: leer archivo y mandar base64
      if (env.STORAGE_DRIVER === 'local') {
        const full = path.join(env.STORAGE_LOCAL_PATH, image.storageKey);
        const buf = await fs.readFile(full);
        resp = await tn.uploadImage(product.tnMapping.tnProductId, {
          attachment: buf.toString('base64'),
          filename,
          position: tnPos,
        });
      } else {
        throw new Error('Cannot upload image to TN');
      }
    }
    await prisma.productImage.update({
      where: { id: image.id },
      data: { tnImageId: String(resp.id) },
    });
    return { tnImageId: resp.id };
  },

  async push_image_delete(payload: { tnProductId: string; tnImageId: string }) {
    const tn = await getTnClient();
    if (!tn) throw new Error('TN not connected');
    await tn.deleteImage(payload.tnProductId, payload.tnImageId).catch(() => null);
    return { ok: true };
  },

  async fulfill_tn_order(payload: { tnOrderId: string; saleId: string }) {
    const tn = await getTnClient();
    if (!tn) throw new Error('TN not connected');
    await tn.fulfillOrder(payload.tnOrderId);
    return { ok: true };
  },
};

export type SyncOperation = keyof typeof syncHandlers;
