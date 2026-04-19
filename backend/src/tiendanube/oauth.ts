import axios from 'axios';
import { env } from '../config.js';
import { prisma } from '../db.js';
import { encrypt, randomId } from '../utils/crypto.js';
import { logAudit, AUDIT_ACTIONS } from '../utils/audit.js';

const TOKEN_URL = 'https://www.tiendanube.com/apps/authorize/token';

export function buildAuthorizeUrl(state?: string): string {
  const params = new URLSearchParams({
    client_id: env.TN_CLIENT_ID,
    state: state ?? randomId(),
  });
  return `${env.TN_AUTH_BASE}/${env.TN_CLIENT_ID}/authorize?${params}`;
}

export async function exchangeCodeForToken(code: string) {
  const res = await axios.post(TOKEN_URL, {
    client_id: env.TN_CLIENT_ID,
    client_secret: env.TN_CLIENT_SECRET,
    grant_type: 'authorization_code',
    code,
  });
  // response: { access_token, token_type, scope, user_id }
  return res.data as {
    access_token: string;
    token_type: string;
    scope: string;
    user_id: number;
  };
}

export async function saveIntegration(data: {
  accessToken: string;
  scope: string;
  tnStoreId: string;
  webhookSecret: string;
}, userId?: string) {
  const enc = encrypt(data.accessToken);
  const integration = await prisma.integration.upsert({
    where: { provider: 'tiendanube' },
    update: {
      accessTokenEnc: enc,
      scope: data.scope,
      tnStoreId: data.tnStoreId,
      webhookSecret: data.webhookSecret,
      active: true,
      connectedAt: new Date(),
    },
    create: {
      provider: 'tiendanube',
      accessTokenEnc: enc,
      scope: data.scope,
      tnStoreId: data.tnStoreId,
      webhookSecret: data.webhookSecret,
      active: true,
    },
  });
  await logAudit({
    userId,
    action: AUDIT_ACTIONS.TN_CONNECTED,
    entity: 'integration',
    entityId: integration.id,
    description: `Tienda Nube conectada (store ${data.tnStoreId})`,
  });
  return integration;
}

export async function disconnect(userId?: string) {
  const integration = await prisma.integration.findUnique({ where: { provider: 'tiendanube' } });
  if (!integration) return;
  await prisma.integration.update({
    where: { provider: 'tiendanube' },
    data: { active: false },
  });
  await logAudit({
    userId,
    action: AUDIT_ACTIONS.TN_DISCONNECTED,
    entity: 'integration',
    entityId: integration.id,
  });
}

// Registrar webhooks cr\u00edticos al conectar
export async function registerWebhooks(baseUrl: string) {
  const { requireTnClient } = await import('./client.js');
  const tn = await requireTnClient();
  const url = `${baseUrl}/webhooks/tiendanube`;
  const events = ['order/paid', 'order/cancelled', 'product/created', 'product/updated', 'product/deleted', 'customer/created'];
  const existing = await tn.listWebhooks().catch(() => []);
  for (const ev of events) {
    const already = Array.isArray(existing) && existing.find((w: any) => w.event === ev);
    if (already) continue;
    await tn.createWebhook(ev, url).catch((e) => {
      console.error(`Failed to register webhook ${ev}`, e?.response?.data ?? e?.message);
    });
  }
}
