import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PUBLIC_BASE_URL: z.string().url(),

  JWT_SECRET: z.string().min(16),
  JWT_EXPIRES_IN: z.string().default('12h'),
  ENCRYPTION_KEY: z.string().length(64, 'ENCRYPTION_KEY must be 32 bytes in hex (64 chars)'),

  CORS_ORIGINS: z.string().default(''),

  TN_CLIENT_ID: z.string().default(''),
  TN_CLIENT_SECRET: z.string().default(''),
  TN_API_BASE: z.string().default('https://api.tiendanube.com/v1'),
  TN_AUTH_BASE: z.string().default('https://www.tiendanube.com/apps'),

  STORAGE_DRIVER: z.enum(['local', 'r2']).default('local'),
  STORAGE_LOCAL_PATH: z.string().default('./storage/images'),
  STORAGE_PUBLIC_URL: z.string().default('http://localhost:3000/images'),
  R2_ACCOUNT_ID: z.string().default(''),
  R2_ACCESS_KEY: z.string().default(''),
  R2_SECRET_KEY: z.string().default(''),
  R2_BUCKET: z.string().default(''),
  R2_PUBLIC_URL: z.string().default(''),

  SYNC_WORKER_INTERVAL_MS: z.coerce.number().default(5000),
  SYNC_MAX_RETRIES: z.coerce.number().default(5),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('\u274c Invalid environment:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

export const corsOrigins = env.CORS_ORIGINS
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
