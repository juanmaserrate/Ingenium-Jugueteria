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
    // Subir im\u00e1genes
    for (const img of product.images) {
      await tn.uploadImage(tnProduct.id, { src: img.url, position: img.position }).catch(() => null);
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
    if (!product?.tnMapping || !image) return { skipped: true };
    // Preferimos enviar URL p\u00fablica; fallback attachment base64 si es local sin internet p\u00fablico
    let resp: any;
    try {
      resp = await tn.uploadImage(product.tnMapping.tnProductId, {
        src: image.url,
        position: image.position,
      });
    } catch {
      // Fallback: leer archivo y mandar base64
      if (env.STORAGE_DRIVER === 'local') {
        const full = path.join(env.STORAGE_LOCAL_PATH, image.storageKey);
        const buf = await fs.readFile(full);
        resp = await tn.uploadImage(product.tnMapping.tnProductId, {
          attachment: buf.toString('base64'),
          position: image.position,
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
