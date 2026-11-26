import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { env } from '../config.js';
import { prisma } from '../db.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import { refreshAccessToken } from './oauth.js';

const PROVIDER = 'mercadolibre';
const REFRESH_MARGIN_MS = 10 * 60 * 1000; // refrescar 10 min antes de vencer
const MAX_429_RETRIES = 4;

// --- Renovación de token serializada (single-flight) ---
// El refresh token de ML es DE UN SOLO USO: dos refresh en paralelo se invalidan entre sí
// y matan la conexión. Por eso toda renovación pasa por esta única promesa compartida: si
// ya hay un refresh en curso, los demás esperan el mismo resultado en vez de disparar otro.
let refreshInFlight: Promise<string> | null = null;

function doRefresh(): Promise<string> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const integ = await prisma.integration.findUnique({ where: { provider: PROVIDER } });
    if (!integ?.refreshTokenEnc) throw new Error('Mercado Libre: sin refresh token — reautorizar');
    try {
      const tok = await refreshAccessToken(decrypt(integ.refreshTokenEnc));
      await prisma.integration.update({
        where: { provider: PROVIDER },
        data: {
          accessTokenEnc: encrypt(tok.access_token),
          refreshTokenEnc: encrypt(tok.refresh_token), // guardar SIEMPRE el nuevo (el viejo murió)
          tokenExpiresAt: new Date(Date.now() + (tok.expires_in || 0) * 1000),
          mlUserId: String(tok.user_id),
          active: true,
        },
      });
      return tok.access_token;
    } catch (e) {
      // El refresh falló (token vencido a los 6 meses / revocado). No borramos nada: marcamos
      // desconectado para que la UI pida reautorizar. El token viejo queda por si acaso.
      await prisma.integration.update({ where: { provider: PROVIDER }, data: { active: false } }).catch(() => {});
      throw e;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

// Devuelve un access token válido, refrescando (proactivo) si está por vencer.
async function ensureValidToken(): Promise<string> {
  const integ = await prisma.integration.findUnique({ where: { provider: PROVIDER } });
  if (!integ || !integ.active) throw new Error('Mercado Libre no está conectado');
  const expMs = integ.tokenExpiresAt ? new Date(integ.tokenExpiresAt).getTime() : 0;
  if (expMs - Date.now() > REFRESH_MARGIN_MS) return decrypt(integ.accessTokenEnc);
  return doRefresh();
}

export class MlClient {
  private http: AxiosInstance;
  constructor() {
    this.http = axios.create({
      baseURL: env.ML_API_BASE,
      timeout: 30_000,
      headers: { 'User-Agent': 'Ingenium POS (ingenium@local)', 'Content-Type': 'application/json' },
    });
  }

  // Request con token válido + reintento ante 429 (Retry-After) y un único refresh+retry ante 401.
  private async req<T = any>(cfg: AxiosRequestConfig, _retried401 = false): Promise<T> {
    const token = await ensureValidToken();
    try {
      const res = await this.http.request<T>({ ...cfg, headers: { ...cfg.headers, Authorization: `Bearer ${token}` } });
      return res.data;
    } catch (error: any) {
      const status = error?.response?.status;
      // 401: el token murió entre requests → refrescar una vez y reintentar.
      if (status === 401 && !_retried401) {
        await doRefresh();
        return this.req<T>(cfg, true);
      }
      // 429: respetar Retry-After (o backoff exponencial) y reintentar hasta MAX.
      if (status === 429) {
        const tries = ((cfg as any).__retry429 ?? 0) + 1;
        if (tries <= MAX_429_RETRIES) {
          const ra = Number(error.response?.headers?.['retry-after']);
          const waitMs = Number.isFinite(ra) && ra > 0 ? Math.min(60_000, ra * 1000) : Math.min(30_000, 1000 * 2 ** tries);
          await new Promise((r) => setTimeout(r, waitMs));
          return this.req<T>({ ...cfg, __retry429: tries } as any, _retried401);
        }
      }
      throw error;
    }
  }

  // --- Cuenta / conexión ---
  getMe() { return this.req({ method: 'get', url: '/users/me' }); }

  // --- Items (publicaciones) ---
  getItem(itemId: string) { return this.req({ method: 'get', url: `/items/${itemId}` }); }
  updateItem(itemId: string, data: any) { return this.req({ method: 'put', url: `/items/${itemId}`, data }); }
  createItem(data: any) { return this.req({ method: 'post', url: '/items', data }); }
  // Actualiza UNA variación sin tocar las demás (PUT /items/{id} con `variations` parcial
  // BORRA las variaciones que no se mandan; este endpoint no).
  updateItemVariation(itemId: string, variationId: string, data: any) {
    return this.req({ method: 'put', url: `/items/${itemId}/variations/${variationId}`, data });
  }
  // Sube una foto (archivo) a ML y devuelve su id, para asociarla después a una publicación
  // con PUT /items/{id} { pictures: [{ id }] }.
  uploadPicture(buf: Buffer, filename: string, mime: string) {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(buf)], { type: mime }), filename);
    // Content-Type explícito: con el JSON por defecto axios convertiría el formulario a JSON.
    return this.req({ method: 'post', url: '/pictures/items/upload', data: form, headers: { 'Content-Type': 'multipart/form-data' } });
  }
  // Publicaciones del vendedor (para detectar las que ya existen). Admite scan scroll.
  searchSellerItems(sellerId: string, params: Record<string, any> = {}) {
    return this.req({ method: 'get', url: `/users/${sellerId}/items/search`, params });
  }
  // Multiget de items (hasta 20 ids) con atributos acotados.
  getItemsMulti(ids: string[], attributes?: string) {
    return this.req({ method: 'get', url: `/items`, params: { ids: ids.join(','), ...(attributes ? { attributes } : {}) } });
  }

  // --- Catálogo de productos (competir en la ficha del producto) ---
  // ¿Se puede sumar a catálogo una publicación propia? status: READY_FOR_OPTIN, ALREADY_OPTED_IN, ...
  catalogEligibility(itemId: string) { return this.req({ method: 'get', url: `/items/${itemId}/catalog_listing_eligibility` }); }
  // Crea la publicación de catálogo a partir de una propia (queda sincronizada con ella).
  catalogOptin(itemId: string, catalogProductId: string, variationId?: string | null) {
    return this.req({ method: 'post', url: '/items/catalog_listings', data: { item_id: itemId, catalog_product_id: catalogProductId, ...(variationId ? { variation_id: Number(variationId) } : {}) } });
  }
  productSearch(params: Record<string, any>) { return this.req({ method: 'get', url: '/products/search', params }); }
  catalogProduct(productId: string) { return this.req({ method: 'get', url: `/products/${productId}` }); }

  // --- Catálogo / categorías (para publicar) ---
  // Predice categoría a partir del título (domain discovery). site: MLA/MLM/MLB/...
  predictCategory(site: string, title: string, limit = 3) {
    return this.req({ method: 'get', url: `/sites/${site}/domain_discovery/search`, params: { limit: Math.min(8, Math.max(1, limit)), q: title } });
  }
  getCategory(categoryId: string) { return this.req({ method: 'get', url: `/categories/${categoryId}` }); }
  // Valida un item SIN crearlo (204 si es publicable). Sirve para probar el armado en vivo.
  validateItem(data: any) { return this.req({ method: 'post', url: '/items/validate', data }); }
  getCategoryAttributes(categoryId: string) { return this.req({ method: 'get', url: `/categories/${categoryId}/attributes` }); }
  setItemDescription(itemId: string, plainText: string) { return this.req({ method: 'post', url: `/items/${itemId}/description`, data: { plain_text: plainText } }); }

  // --- Órdenes ---
  getOrder(orderId: string) { return this.req({ method: 'get', url: `/orders/${orderId}` }); }
  searchOrders(params: Record<string, any>) { return this.req({ method: 'get', url: '/orders/search', params }); }

  // --- Preguntas de compradores (pre-venta) ---
  searchQuestions(params: Record<string, any>) { return this.req({ method: 'get', url: '/questions/search', params }); }
  getQuestion(questionId: string) { return this.req({ method: 'get', url: `/questions/${questionId}`, params: { api_version: 4 } }); }
  answerQuestion(questionId: string, text: string) {
    return this.req({ method: 'post', url: '/answers', data: { question_id: Number(questionId), text } });
  }

  // Calidad de una publicación según ML (puntaje y acciones pendientes).
  itemPerformance(itemId: string) { return this.req({ method: 'get', url: `/item/${itemId}/performance` }); }

  // --- Costos por vender (solo lectura): comisión + costo fijo, y cotización del envío gratis ---
  listingPrices(site: string, params: Record<string, any>) {
    return this.req({ method: 'get', url: `/sites/${site}/listing_prices`, params });
  }
  freeShippingQuote(userId: string, params: Record<string, any>) {
    return this.req({ method: 'get', url: `/users/${userId}/shipping_options/free`, params });
  }

  // --- Envíos Flex (solo lectura): suscripción y rangos de entrega con su horario de corte ---
  flexSubscriptions(site: string, userId: string) {
    return this.req({ method: 'get', url: `/flex/sites/${site}/users/${userId}/subscriptions/v1` });
  }
  flexDeliveryRanges(site: string, userId: string, serviceId: string | number) {
    return this.req({ method: 'get', url: `/flex/sites/${site}/users/${userId}/services/${serviceId}/configurations/delivery-ranges/v1`, params: { show_availables: true } });
  }
  flexZones(site: string, userId: string, serviceId: string | number) {
    return this.req({ method: 'get', url: `/flex/sites/${site}/users/${userId}/services/${serviceId}/configurations/coverage/zones/v1` });
  }

  // --- Notificaciones perdidas ---
  getMyFeeds(params: Record<string, any> = {}) { return this.req({ method: 'get', url: '/myfeeds', params }); }
}

export async function getMlClient(): Promise<MlClient | null> {
  const integ = await prisma.integration.findUnique({ where: { provider: PROVIDER } });
  if (!integ || !integ.active) return null;
  return new MlClient();
}

export async function requireMlClient(): Promise<MlClient> {
  const c = await getMlClient();
  if (!c) throw new Error('Mercado Libre no está conectado');
  return c;
}
