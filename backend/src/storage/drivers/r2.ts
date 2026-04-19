import type { StorageDriver } from '../images.js';
import { env } from '../../config.js';

/**
 * Cloudflare R2 / S3 driver.
 * Implementaci\u00f3n m\u00ednima usando fetch + Signature V4. Para simplificar, si
 * todav\u00eda no configuraste R2 se lanza un error claro. Se puede migrar f\u00e1cilmente
 * a @aws-sdk/client-s3 cuando haga falta m\u00e1s features.
 */
export const r2Driver: StorageDriver = {
  async save(key, _data, _contentType) {
    if (!env.R2_ACCOUNT_ID || !env.R2_BUCKET) {
      throw new Error('R2 driver not configured. Set R2_* env vars or use STORAGE_DRIVER=local.');
    }
    // TODO: implementar upload S3 v4 cuando se decida usar R2 en prod.
    throw new Error('R2 driver not yet implemented. Use STORAGE_DRIVER=local for now.');
  },
  async delete(_key) {
    throw new Error('R2 driver not yet implemented');
  },
  async getBuffer(_key) {
    throw new Error('R2 driver not yet implemented');
  },
};
