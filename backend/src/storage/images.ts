import { env } from '../config.js';
import { localDriver } from './drivers/local.js';
import { r2Driver } from './drivers/r2.js';
import { prisma } from '../db.js';
import { randomId } from '../utils/crypto.js';
import { enqueueSync } from '../sync/queue.js';

export interface StorageDriver {
  save(key: string, data: Buffer, contentType: string): Promise<{ url: string; key: string }>;
  delete(key: string): Promise<void>;
  getBuffer(key: string): Promise<Buffer>;
}

const driver: StorageDriver = env.STORAGE_DRIVER === 'r2' ? r2Driver : localDriver;

export async function saveProductImage(productId: string, data: Buffer, contentType: string, filename: string) {
  const ext = filename.split('.').pop()?.toLowerCase() ?? 'jpg';
  const key = `${productId}/${randomId()}.${ext}`;
  const { url } = await driver.save(key, data, contentType);

  const count = await prisma.productImage.count({ where: { productId } });
  const image = await prisma.productImage.create({
    data: {
      id: randomId(),
      productId,
      url,
      storageKey: key,
      position: count,
    },
  });
  await enqueueSync('push_image_create', { productId, imageId: image.id });
  return image;
}

export async function downloadAndSaveImage(productId: string, sourceUrl: string, tnImageId?: string) {
  const resp = await fetch(sourceUrl);
  if (!resp.ok) throw new Error(`Cannot download image: ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  const contentType = resp.headers.get('content-type') ?? 'image/jpeg';
  const ext = contentType.split('/')[1]?.split(';')[0] ?? 'jpg';
  const key = `${productId}/${randomId()}.${ext}`;
  const { url } = await driver.save(key, buf, contentType);

  const count = await prisma.productImage.count({ where: { productId } });
  return prisma.productImage.create({
    data: {
      id: randomId(),
      productId,
      url,
      storageKey: key,
      position: count,
      tnImageId: tnImageId ?? null,
    },
  });
}

export async function deleteProductImage(imageId: string) {
  const image = await prisma.productImage.findUnique({
    where: { id: imageId },
    include: { product: { include: { tnMapping: true } } },
  });
  if (!image) return;
  await driver.delete(image.storageKey);
  if (image.tnImageId && image.product.tnMapping) {
    await enqueueSync('push_image_delete', {
      tnProductId: image.product.tnMapping.tnProductId,
      tnImageId: image.tnImageId,
    });
  }
  await prisma.productImage.delete({ where: { id: imageId } });
}
