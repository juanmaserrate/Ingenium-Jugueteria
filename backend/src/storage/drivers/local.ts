import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../config.js';
import type { StorageDriver } from '../images.js';

export const localDriver: StorageDriver = {
  async save(key, data, _contentType) {
    const full = path.join(env.STORAGE_LOCAL_PATH, key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, data);
    const url = `${env.STORAGE_PUBLIC_URL.replace(/\/$/, '')}/${key}`;
    return { url, key };
  },
  async delete(key) {
    const full = path.join(env.STORAGE_LOCAL_PATH, key);
    await fs.unlink(full).catch(() => null);
  },
  async getBuffer(key) {
    const full = path.join(env.STORAGE_LOCAL_PATH, key);
    return fs.readFile(full);
  },
};
