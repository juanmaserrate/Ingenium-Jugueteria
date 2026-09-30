import axios, { AxiosInstance } from 'axios';
import { env } from '../config.js';
import { prisma } from '../db.js';
import { decrypt } from '../utils/crypto.js';

export class TnClient {
  private http!: AxiosInstance;

  constructor(private storeId: string, private accessToken: string) {
    this.http = axios.create({
      baseURL: `${env.TN_API_BASE}/${storeId}`,
      timeout: 30_000,
      headers: {
        Authentication: `bearer ${accessToken}`,
        'User-Agent': 'Ingenium POS (ingenium@local)',
        'Content-Type': 'application/json',
      },
    });

    // Rate-limit (429): TN limita las llamadas por tienda. Ante un 429 esperamos lo que
    // pide el header Retry-After (segundos) — o un backoff exponencial si no viene — y
    // reintentamos hasta MAX veces. Como el worker es de un solo hilo, esta espera hace
    // de throttle natural. Solo reintenta 429 (no toca la lógica de los demás errores).
    const MAX_429_RETRIES = 4;
    this.http.interceptors.response.use(undefined, async (error: any) => {
      const cfg = error?.config;
      const status = error?.response?.status;
      if (status === 429 && cfg) {
        cfg.__retry429 = (cfg.__retry429 ?? 0) + 1;
        if (cfg.__retry429 <= MAX_429_RETRIES) {
          const ra = Number(error.response?.headers?.['retry-after']);
          const waitMs = Number.isFinite(ra) && ra > 0
            ? Math.min(60_000, ra * 1000)
            : Math.min(30_000, 1000 * 2 ** cfg.__retry429);
          await new Promise((r) => setTimeout(r, waitMs));
          return this.http.request(cfg);
        }
      }
      return Promise.reject(error);
    });
  }

  // --- Products ---
  listProducts(params: Record<string, any> = {}) {
    return this.http.get('/products', { params }).then((r) => r.data);
  }
  getProduct(tnId: string | number) {
    return this.http.get(`/products/${tnId}`).then((r) => r.data);
  }
  createProduct(data: any) {
    return this.http.post('/products', data).then((r) => r.data);
  }
  updateProduct(tnId: string | number, data: any) {
    return this.http.put(`/products/${tnId}`, data).then((r) => r.data);
  }
  deleteProduct(tnId: string | number) {
    return this.http.delete(`/products/${tnId}`).then((r) => r.data);
  }

  // --- Variants ---
  createVariant(tnProductId: string | number, data: any) {
    return this.http.post(`/products/${tnProductId}/variants`, data).then((r) => r.data);
  }
  updateVariant(tnProductId: string | number, tnVariantId: string | number, data: any) {
    return this.http.put(`/products/${tnProductId}/variants/${tnVariantId}`, data).then((r) => r.data);
  }
  deleteVariant(tnProductId: string | number, tnVariantId: string | number) {
    return this.http.delete(`/products/${tnProductId}/variants/${tnVariantId}`).then((r) => r.data);
  }

  // --- Categories ---
  listCategories(params: Record<string, any> = {}) {
    return this.http.get('/categories', { params }).then((r) => r.data);
  }

  // --- Images ---
  uploadImage(tnProductId: string | number, data: { src?: string; attachment?: string; filename?: string; position?: number }) {
    return this.http.post(`/products/${tnProductId}/images`, data).then((r) => r.data);
  }
  deleteImage(tnProductId: string | number, tnImageId: string | number) {
    return this.http.delete(`/products/${tnProductId}/images/${tnImageId}`).then((r) => r.data);
  }

  // --- Orders ---
  getOrder(tnOrderId: string | number) {
    return this.http.get(`/orders/${tnOrderId}`).then((r) => r.data);
  }
  fulfillOrder(tnOrderId: string | number) {
    return this.http
      .post(`/orders/${tnOrderId}/fulfill`, { notify_customer: false })
      .then((r) => r.data);
  }
  closeOrder(tnOrderId: string | number) {
    return this.http.post(`/orders/${tnOrderId}/close`).then((r) => r.data);
  }

  // --- Customers ---
  getCustomer(tnCustomerId: string | number) {
    return this.http.get(`/customers/${tnCustomerId}`).then((r) => r.data);
  }

  // --- Webhooks ---
  listWebhooks() {
    return this.http.get('/webhooks').then((r) => r.data);
  }
  createWebhook(event: string, url: string) {
    return this.http.post('/webhooks', { event, url }).then((r) => r.data);
  }
  deleteWebhook(id: string | number) {
    return this.http.delete(`/webhooks/${id}`).then((r) => r.data);
  }
}

export async function getTnClient(): Promise<TnClient | null> {
  const integration = await prisma.integration.findUnique({ where: { provider: 'tiendanube' } });
  if (!integration || !integration.active || !integration.tnStoreId) return null;
  const token = decrypt(integration.accessTokenEnc);
  return new TnClient(integration.tnStoreId, token);
}

export async function requireTnClient(): Promise<TnClient> {
  const c = await getTnClient();
  if (!c) throw new Error('Tienda Nube no est\u00e1 conectada');
  return c;
}
