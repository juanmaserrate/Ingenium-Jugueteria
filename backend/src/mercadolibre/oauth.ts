import axios from 'axios';
import { env } from '../config.js';
import { prisma } from '../db.js';
import { encrypt } from '../utils/crypto.js';
import { logAudit, AUDIT_ACTIONS } from '../utils/audit.js';

// OAuth 2.0 de Mercado Libre. A diferencia de Tienda Nube, el access token EXPIRA
// (~3-6h) y hay un refresh token DE UN SOLO USO (cada refresh devuelve uno nuevo y el
// anterior se invalida). Por eso se guardan refresh_token + expiración y la renovación
// se serializa (ver client.ts, single-flight) para no pisar un refresh con otro.

const PROVIDER = 'mercadolibre';

// El redirect debe coincidir EXACTO con el registrado en el DevCenter.
export function getRedirectUri(): string {
  return env.ML_REDIRECT_URI || `${env.PUBLIC_BASE_URL}/api/integrations/ml/callback`;
}

export function buildAuthorizeUrl(state?: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: env.ML_CLIENT_ID,
    redirect_uri: getRedirectUri(),
  });
  if (state) params.set('state', state);
  return `${env.ML_AUTH_BASE}/authorization?${params}`;
}

type MlTokenResponse = {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  user_id: number;
  refresh_token: string;
};

// POST al endpoint de token de ML. Se pasa un URLSearchParams (axios lo serializa como
// application/x-www-form-urlencoded, que es lo que pide ML) y se loguea el detalle si falla
// para diagnosticar (sin exponer el secreto: solo su longitud).
async function postToken(fields: Record<string, string>): Promise<MlTokenResponse> {
  const tokenUrl = `${env.ML_API_BASE}/oauth/token`;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) params.append(k, v);
  try {
    const res = await axios.post(tokenUrl, params, { headers: { accept: 'application/json' } });
    return res.data as MlTokenResponse;
  } catch (err: any) {
    console.error('[ml] token request failed', JSON.stringify({
      tokenUrl,
      grant_type: fields.grant_type,
      clientIdLen: (env.ML_CLIENT_ID || '').length,
      clientSecretLen: (env.ML_CLIENT_SECRET || '').length,
      redirectUri: fields.redirect_uri,
      status: err?.response?.status,
      data: err?.response?.data,
      location: err?.response?.headers?.location,
      sentContentType: err?.config?.headers?.['Content-Type'] ?? err?.config?.headers?.['content-type'],
    }));
    throw err;
  }
}

export async function exchangeCodeForToken(code: string): Promise<MlTokenResponse> {
  return postToken({
    grant_type: 'authorization_code',
    client_id: env.ML_CLIENT_ID,
    client_secret: env.ML_CLIENT_SECRET,
    code,
    redirect_uri: getRedirectUri(),
  });
}

// Refresh del access token usando el refresh token actual. Devuelve nuevos access +
// refresh (el refresh viejo queda invalidado → hay que guardar el nuevo sí o sí).
export async function refreshAccessToken(refreshToken: string): Promise<MlTokenResponse> {
  return postToken({
    grant_type: 'refresh_token',
    client_id: env.ML_CLIENT_ID,
    client_secret: env.ML_CLIENT_SECRET,
    refresh_token: refreshToken,
  });
}

// Guarda/actualiza la fila Integration(provider='mercadolibre') con tokens cifrados.
export async function saveMlIntegration(data: {
  accessToken: string;
  refreshToken: string;
  expiresIn: number; // segundos
  scope: string;
  mlUserId: string;
}, userId?: string) {
  const expiresAt = new Date(Date.now() + (data.expiresIn || 0) * 1000);
  const integration = await prisma.integration.upsert({
    where: { provider: PROVIDER },
    update: {
      accessTokenEnc: encrypt(data.accessToken),
      refreshTokenEnc: encrypt(data.refreshToken),
      tokenExpiresAt: expiresAt,
      scope: data.scope,
      mlUserId: data.mlUserId,
      active: true,
      connectedAt: new Date(),
    },
    create: {
      provider: PROVIDER,
      accessTokenEnc: encrypt(data.accessToken),
      refreshTokenEnc: encrypt(data.refreshToken),
      tokenExpiresAt: expiresAt,
      scope: data.scope,
      mlUserId: data.mlUserId,
      active: true,
    },
  });
  await logAudit({
    userId,
    action: AUDIT_ACTIONS.ML_CONNECTED,
    entity: 'integration',
    entityId: integration.id,
    description: `Mercado Libre conectado (seller ${data.mlUserId})`,
  });
  return integration;
}

export async function disconnect(userId?: string) {
  const integration = await prisma.integration.findUnique({ where: { provider: PROVIDER } });
  if (!integration) return;
  await prisma.integration.update({ where: { provider: PROVIDER }, data: { active: false } });
  await logAudit({
    userId,
    action: AUDIT_ACTIONS.ML_DISCONNECTED,
    entity: 'integration',
    entityId: integration.id,
  });
}
