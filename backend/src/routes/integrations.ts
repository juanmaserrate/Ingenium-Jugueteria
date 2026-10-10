import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { env } from '../config.js';
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  saveIntegration,
  disconnect,
  registerWebhooks,
} from '../tiendanube/oauth.js';
import { randomId } from '../utils/crypto.js';
import { ValidationError } from '../utils/errors.js';
import { requireRole } from '../auth/jwt.js';
import { confirmSale } from '../services/sales.js';
import { enqueueSync } from '../sync/queue.js';
import { getTnClient } from '../tiendanube/client.js';
import { ingestPaidOrder } from '../tiendanube/webhooks.js';
import { linkByBarcode, dumpTnCatalog, searchTnCatalog, linkManual, linkManualVariants, unlinkProduct, relinkProduct, findCodeMismatches, alignTnBarcode, enqueueAlignAllBarcodes } from '../tiendanube/link.js';

// Una orden de TN deja de necesitar asignación cuando ya está cancelada/cerrada o
// enviada/entregada/retirada. Chequeamos el estado ACTUAL en TN (el payload guardado es
// del momento del pago y queda viejo). Cacheamos el resultado en memoria un rato para no
// pegarle a TN en cada auto-refresh (la pantalla refresca cada 30s).
const TN_SHIPPED_STATES = new Set(['shipped', 'fulfilled', 'delivered']);
const tnDoneCache = new Map<string, { checkedAt: number; done: boolean }>();
const TN_DONE_TTL_MS = 5 * 60 * 1000;

function tnOrderIsDone(order: any): boolean {
  const status = String(order?.status ?? '');
  if (status === 'cancelled' || status === 'closed') return true;
  if (TN_SHIPPED_STATES.has(String(order?.shipping_status ?? ''))) return true;
  if (order?.shipped_at) return true;
  return false;
}

// --- Respaldo de órdenes (reconcilia webhooks perdidos) ---
// Trae de la API de TN las órdenes PAGADAS y ABIERTAS recientes e ingresa las que faltan
// localmente. Solo entran las que están "por enviar / por retirar" (pago recibido y NO
// enviadas/entregadas/canceladas/cerradas), igual que el filtro de la vista de pendientes.
// Con throttle en memoria para no pegarle de más a TN pase lo que pase la frecuencia de poll.
let lastReconcileAt = 0;
let reconcileInFlight = false;
const RECONCILE_THROTTLE_MS = 3 * 60 * 1000;

async function reconcileTnOrders(): Promise<{ scanned: number; ingested: number; skippedDone: number } | null> {
  const tn = await getTnClient();
  if (!tn) return null;
  const sinceIso = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(); // últimos 60 días
  let scanned = 0, ingested = 0, skippedDone = 0;
  for (let page = 1; page <= 10; page++) {
    let batch: any;
    try {
      batch = await tn.listOrders({ status: 'open', payment_status: 'paid', per_page: 50, page, created_at_min: sinceIso });
    } catch {
      break;
    }
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const order of batch) {
      scanned++;
      if (tnOrderIsDone(order)) { skippedDone++; continue; } // ya enviada/retirada/cerrada
      const tnOrderId = String(order.id);
      const existing = await prisma.tnOrderPending.findUnique({ where: { tnOrderId } });
      if (existing) continue;
      try { await ingestPaidOrder(order); ingested++; } catch { /* no frenar el resto */ }
    }
    if (batch.length < 50) break;
  }
  return { scanned, ingested, skippedDone };
}

// Dispara el reconcile como mucho 1 vez cada RECONCILE_THROTTLE_MS. No bloquea: si ya
// pasó el tiempo, corre en background y devuelve enseguida (el refresh siguiente ve el resultado).
function maybeReconcile() {
  if (reconcileInFlight) return;
  if (Date.now() - lastReconcileAt < RECONCILE_THROTTLE_MS) return;
  lastReconcileAt = Date.now();
  reconcileInFlight = true;
  reconcileTnOrders().catch(() => {}).finally(() => { reconcileInFlight = false; });
}

export async function integrationsRoutes(app: FastifyInstance) {
  // Status p\u00fablico (sin auth) para el ping del frontend
  app.get('/integrations/status', async () => {
    const integration = await prisma.integration.findUnique({ where: { provider: 'tiendanube' } });
    return {
      connected: !!integration?.active,
      tnStoreId: integration?.tnStoreId ?? null,
      connectedAt: integration?.connectedAt ?? null,
      lastSyncAt: integration?.lastSyncAt ?? null,
      stockMode: integration?.stockMode ?? 'sum',
    };
  });

  // --- OAuth flow ---
  app.get('/integrations/tiendanube/authorize', async (_req, reply) => {
    if (!env.TN_CLIENT_ID) {
      return reply.status(500).send({ error: 'TN_CLIENT_ID no configurado' });
    }
    const url = buildAuthorizeUrl();
    return reply.redirect(url);
  });

  app.get('/integrations/tiendanube/callback', async (req, reply) => {
    const code = (req.query as any).code as string | undefined;
    if (!code) return reply.status(400).send({ error: 'Missing code' });
    try {
      const token = await exchangeCodeForToken(code);
      const webhookSecret = randomId(32);
      await saveIntegration({
        accessToken: token.access_token,
        scope: token.scope,
        tnStoreId: String(token.user_id),
        webhookSecret,
      });
      await registerWebhooks(env.PUBLIC_BASE_URL);
      // Redirect de vuelta al frontend (hash route). Prefiere PUBLIC_BASE_URL
      // (dominio público del deploy) sobre CORS_ORIGINS para no terminar en localhost.
      const base = env.PUBLIC_BASE_URL || env.CORS_ORIGINS.split(',')[0] || '';
      return reply.redirect(`${base}/app.html#/integraciones?connected=1`);
    } catch (err: any) {
      app.log.error(err);
      return reply.status(500).send({ error: 'OAuth failed', details: err.message });
    }
  });

  // --- Rutas autenticadas ---
  app.register(async (r) => {
    r.addHook('preHandler', app.authenticate);

    // La configuración de la integración y las operaciones masivas de catálogo/stock
    // hacia TN son solo del admin. Las lecturas (status, listados) y la asignación de
    // órdenes a sucursal (tarea diaria del operador) quedan abiertas.
    const adminOnly = { preHandler: requireRole('admin') };

    r.post('/integrations/tiendanube/disconnect', adminOnly, async (req) => {
      await disconnect(req.user.userId);
      return { ok: true };
    });

    // Enlaza productos del sistema con TN por código de barras / SKU (lee la API de TN).
    // dryRun=true (default) solo reporta; dryRun=false crea los mapeos.
    r.post('/integrations/tiendanube/link-by-barcode', adminOnly, async (req) => {
      const body = z.object({ dryRun: z.boolean().optional() }).parse(req.body ?? {});
      return linkByBarcode({ dryRun: body.dryRun ?? true });
    });

    // Vuelca el catálogo de TN (API, barcodes completos) para cruzar offline.
    r.get('/integrations/tiendanube/catalog-dump', async () => {
      return dumpTnCatalog();
    });

    // Búsqueda puntual en TN por término (para el picker de vinculación): rápida, solo
    // trae los que coinciden con ?q= en vez de volcar todo el catálogo.
    r.get('/integrations/tiendanube/catalog-search', adminOnly, async (req) => {
      const { q } = req.query as { q?: string };
      return searchTnCatalog(q ?? '');
    });

    // Chequeo de códigos desalineados local ↔ Tienda Nube (para detectar casos como
    // "El erudito"/"Puzzle noche estrellada"). Solo admin; puede tardar un par de minutos.
    r.get('/integrations/tiendanube/code-mismatch', adminOnly, async () => {
      return findCodeMismatches();
    });
    // Pisa el barcode de la variante en TN con el código local (cuando el local es el bueno).
    r.post('/integrations/tiendanube/align-barcode', adminOnly, async (req) => {
      const body = z.object({ productId: z.string() }).parse(req.body);
      return alignTnBarcode(body.productId);
    });
    // Alineación MASIVA: pisa el barcode de TN con el código del sistema en todos los
    // enlazados que no coinciden. dryRun=true solo cuenta (no toca nada).
    r.post('/integrations/tiendanube/align-all-barcodes', adminOnly, async (req) => {
      const body = z.object({ dryRun: z.boolean().optional() }).parse(req.body ?? {});
      return enqueueAlignAllBarcodes({ dryRun: body.dryRun });
    });
    // Diagnóstico: lee un producto en TN (precio y promo por variante) para verificar sync.
    r.get('/integrations/tiendanube/product/:tnId/raw', adminOnly, async (req) => {
      const { tnId } = req.params as { tnId: string };
      const tn = await getTnClient();
      if (!tn) return { error: 'TN no conectada' };
      const p = await tn.getProduct(tnId).catch((e: any) => ({ error: e?.response?.status || String(e?.message || e) }));
      if ((p as any)?.error) return p;
      const variants = ((p as any).variants || []).map((v: any) => ({ id: v.id, price: v.price, promotional_price: v.promotional_price, sku: v.sku, barcode: v.barcode }));
      return { tnProductId: tnId, name: (p as any).name, variants };
    });
    // Diagnóstico: fulfillment-orders de una orden TN (para verificar el modelo de armado/envío).
    r.get('/integrations/tiendanube/order/:id/fulfillment-orders', adminOnly, async (req) => {
      const { id } = req.params as { id: string };
      const tn = await getTnClient();
      if (!tn) return { error: 'TN no conectada' };
      const fos = await tn.listFulfillmentOrders(id).catch((e: any) => ({ error: e?.response?.status || String(e?.message || e), data: e?.response?.data }));
      return { tnOrderId: id, fulfillmentOrders: fos };
    });
    // Marca manualmente una orden TN como EMPAQUETADA (no enviada). Para operación/pruebas.
    r.post('/integrations/tiendanube/order/:id/pack', adminOnly, async (req) => {
      const { id } = req.params as { id: string };
      const { packTnOrder } = await import('../tiendanube/sync.js');
      return packTnOrder(id);
    });

    // Productos creados en TN desde `since` (YYYY-MM-DD, hora Argentina) que NO
    // están enlazados a un producto del sistema. Solo lectura (para revisar antes
    // de importar). Devuelve resumen por producto.
    r.get('/integrations/tiendanube/new-products', async (req) => {
      const q = req.query as { since?: string };
      const since = q.since || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      const tn = await getTnClient();
      if (!tn) throw new Error('Tienda Nube no está conectada');
      const createdMin = `${since}T00:00:00-03:00`;
      const linked = new Set(
        (await prisma.productTnMapping.findMany({ select: { tnProductId: true } })).map((m) => m.tnProductId),
      );
      const out: any[] = [];
      let page = 1;
      let warning: string | null = null;
      for (;;) {
        let batch: any;
        try {
          batch = await tn.listProducts({
            page,
            per_page: 200,
            created_at_min: createdMin,
            fields: 'id,name,created_at,variants',
          });
        } catch (e: any) {
          const s = e?.response?.status;
          if (s === 404) break;
          warning = `Error página ${page}: HTTP ${s ?? ''} ${e?.message ?? e}`;
          break;
        }
        if (!Array.isArray(batch) || batch.length === 0) break;
        for (const tp of batch) {
          if (linked.has(String(tp.id))) continue;
          const vs: any[] = tp.variants ?? [];
          const v0 = vs[0] ?? {};
          out.push({
            tnProductId: String(tp.id),
            name: tp.name?.es ?? tp.name ?? '',
            createdAt: tp.created_at ?? null,
            variantCount: vs.length,
            sku: v0.sku ?? '',
            barcode: v0.barcode ?? '',
            price: v0.price ?? '',
            stock: vs.reduce((s, v) => s + (Number(v.stock) || 0), 0),
          });
        }
        page++;
        if (page > 200) break;
      }
      return { since, count: out.length, warning, products: out };
    });

    // Importa productos de TN al sistema y los enlaza. Para cada tnProductId:
    // crea producto local + variantes + mappings, carga el stock actual de TN en
    // `stockBranchId` (0 en las demás sucursales) y opcionalmente asigna el
    // proveedor deducido del final del nombre ("... - Proveedor"). NO empuja stock
    // a TN (el stock viene DESDE TN). Idempotente por tnProductId (si ya está
    // enlazado, lo saltea).
    r.post('/integrations/tiendanube/import-products', adminOnly, async (req) => {
      const body = z
        .object({
          tnProductIds: z.array(z.string()).min(1),
          stockBranchId: z.string(),
          assignSupplierFromName: z.boolean().optional(),
        })
        .parse(req.body);
      const tn = await getTnClient();
      if (!tn) throw new Error('Tienda Nube no está conectada');
      const branches = await prisma.branch.findMany();
      const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
      const suppliers = await prisma.supplier.findMany();
      const supByName = new Map(suppliers.map((s) => [norm(s.name), s.id]));

      async function resolveSupplier(name: string): Promise<string | null> {
        if (!body.assignSupplierFromName) return null;
        const parts = String(name).split(' - ');
        if (parts.length < 2) return null;
        const supName = parts[parts.length - 1].trim();
        if (!supName) return null;
        const key = norm(supName);
        if (supByName.has(key)) return supByName.get(key)!;
        const created = await prisma.supplier.create({ data: { id: randomId(), name: supName } });
        supByName.set(key, created.id);
        return created.id;
      }

      const results: any[] = [];
      for (const tnId of body.tnProductIds) {
        try {
          const existing = await prisma.productTnMapping.findFirst({ where: { tnProductId: String(tnId) } });
          if (existing) { results.push({ tnProductId: tnId, skipped: 'ya enlazado' }); continue; }
          const tp = await tn.getProduct(tnId);
          const name = tp.name?.es ?? tp.name ?? `Producto TN ${tnId}`;
          const supplierId = await resolveSupplier(name);
          const variantsTn: any[] = tp.variants ?? [];
          const productId = randomId();
          await prisma.$transaction(async (tx) => {
            await tx.product.create({
              data: {
                id: productId,
                code: variantsTn[0]?.sku || variantsTn[0]?.barcode || `TN-${tnId}`,
                name,
                description: tp.description?.es ?? null,
                cost: 0,
                price: variantsTn[0] ? parseFloat(variantsTn[0].price) || 0 : 0,
                publishedTn: true,
                supplierId: supplierId ?? undefined,
              },
            });
            await tx.productTnMapping.create({
              data: { productId, tnProductId: String(tnId), lastPullAt: new Date() },
            });
            for (const tnV of variantsTn) {
              const vid = randomId();
              const attrs: Record<string, string> = {};
              (tnV.values ?? []).forEach((val: any, idx: number) => {
                const attrName = tp.attributes?.[idx]?.es ?? `attr${idx + 1}`;
                attrs[attrName] = val?.es ?? val;
              });
              await tx.variant.create({
                data: {
                  id: vid,
                  productId,
                  name: (tnV.values ?? []).map((v: any) => v?.es ?? v).join(' / ') || 'default',
                  attributes: attrs as any,
                  code: tnV.sku || null,
                  barcode: tnV.barcode || null,
                  priceOverride: parseFloat(tnV.price) || null,
                  costOverride: null,
                  isDefault: variantsTn.length === 1,
                },
              });
              await tx.variantTnMapping.create({
                data: { variantId: vid, tnProductId: String(tnId), tnVariantId: String(tnV.id), lastPullAt: new Date() },
              });
              const tnStock = Math.max(0, Number(tnV.stock) || 0);
              for (const b of branches) {
                await tx.stock.create({
                  data: {
                    id: `${vid}|${b.id}`,
                    variantId: vid,
                    branchId: b.id,
                    qty: b.id === body.stockBranchId ? tnStock : 0,
                  },
                });
              }
            }
          });
          results.push({ tnProductId: tnId, productId, name, variants: variantsTn.length, supplierId: supplierId ?? null });
        } catch (e: any) {
          results.push({ tnProductId: tnId, error: e?.message ?? String(e) });
        }
      }
      return { imported: results.filter((r) => r.productId).length, results };
    });

    // Lista los mapeos producto local ↔ producto TN (código local + tnProductId).
    r.get('/integrations/tiendanube/mappings', async () => {
      const maps = await prisma.productTnMapping.findMany({
        include: { product: { select: { code: true, name: true } } },
      });
      return maps.map((m) => ({ code: m.product.code, name: m.product.name, tnProductId: m.tnProductId }));
    });

    // Vinculación manual producto del sistema ↔ producto TN (elegido por el usuario).
    r.post('/integrations/tiendanube/link-manual', adminOnly, async (req) => {
      const body = z.object({ productId: z.string(), tnProductId: z.string(), tnVariantId: z.string().optional() }).parse(req.body);
      return linkManual(body);
    });
    // Vinculación manual de un producto CON variantes ↔ producto TN con variantes.
    // Empareja cada variante (por barcode/código, o por valor talle/color/modelo)
    // y devuelve las que quedaron sin casar para resolver a mano.
    r.post('/integrations/tiendanube/link-variants', adminOnly, async (req) => {
      const body = z.object({ productId: z.string(), tnProductId: z.string() }).parse(req.body);
      return linkManualVariants(body);
    });
    r.post('/integrations/tiendanube/unlink', adminOnly, async (req) => {
      const body = z.object({ productId: z.string() }).parse(req.body);
      return unlinkProduct(body.productId);
    });
    // Re-enlazar: desvincula el vínculo actual y enlaza a OTRO producto de TN en un paso,
    // eligiendo con qué datos quedarse ('tn' = traer descripción/precio desde TN;
    // 'system' = publicar nombre/descripción/precio del sistema en TN).
    r.post('/integrations/tiendanube/relink', adminOnly, async (req) => {
      const body = z.object({
        productId: z.string(),
        tnProductId: z.string(),
        tnVariantId: z.string().optional(),
        dataSource: z.enum(['tn', 'system']),
      }).parse(req.body);
      return relinkProduct(body);
    });

    r.patch('/integrations/tiendanube/settings', async (req) => {
      const body = z
        .object({ stockMode: z.enum(['sum', 'lomas', 'banfield']).optional() })
        .parse(req.body);
      const updated = await prisma.integration.update({
        where: { provider: 'tiendanube' },
        data: { stockMode: body.stockMode ?? undefined },
      });
      return updated;
    });

    // Listado plano de categorías de la tienda TN (para el select del modal de producto).
    // TN devuelve árbol; lo aplanamos con indentación visual por nivel.
    r.get('/tiendanube/categories', async () => {
      const tn = await getTnClient();
      if (!tn) return { connected: false, categories: [] as Array<{ id: number; name: string; level: number }> };
      // Paginado simple: pedimos hasta 200 (suficiente para la mayoría de tiendas).
      const raw = await tn.listCategories({ per_page: 200 }) as any[];
      const flat: Array<{ id: number; name: string; level: number; parent: number | null }> = raw.map((c) => {
        // TN devuelve parent: 0 para raíz (no null). Normalizamos a null para
        // que el frontend pueda detectar "sin parent" con un solo check.
        const rawParent = c.parent != null ? Number(c.parent) : null;
        const parent = rawParent && rawParent > 0 ? rawParent : null;
        return {
          id: Number(c.id),
          name: (c.name?.es ?? c.name?.en ?? String(c.id)) as string,
          level: 0,
          parent,
        };
      });
      // Calcular niveles a partir del parent. Hacemos pases hasta que estabilice.
      const byId = new Map(flat.map((c) => [c.id, c]));
      let changed = true;
      let safety = 10;
      while (changed && safety-- > 0) {
        changed = false;
        for (const c of flat) {
          if (c.parent != null) {
            const p = byId.get(c.parent);
            if (p && p.level + 1 !== c.level) { c.level = p.level + 1; changed = true; }
          }
        }
      }
      flat.sort((a, b) => a.name.localeCompare(b.name));
      return { connected: true, categories: flat };
    });

    // --- TN Orders Pending ---
    // Conteo liviano de pendientes (para el badge del sidebar). Dispara el respaldo
    // throttled para captar las que se perdieron por webhook, aun desde otras pantallas.
    r.get('/tn-orders/pending-count', async () => {
      maybeReconcile();
      const count = await prisma.tnOrderPending.count({ where: { status: 'pending' } });
      return { count };
    });

    // Sincronización manual de órdenes (ignora el throttle): trae de TN las pagadas abiertas
    // e ingresa las que falten. Devuelve el reporte. Útil como "traer ahora" y para diagnóstico.
    r.post('/tn-orders/sync', adminOnly, async () => {
      const rep = await reconcileTnOrders();
      return rep ?? { error: 'TN no conectada' };
    });

    r.get('/tn-orders', async (req) => {
      maybeReconcile(); // respaldo: ingiere pagadas no-enviadas que falten (throttled)
      const q = req.query as { status?: string };
      const status = q.status ?? 'pending';
      const orders = await prisma.tnOrderPending.findMany({
        where: { status },
        orderBy: { receivedAt: 'desc' },
        take: 500,
      });
      // Solo la vista de PENDIENTES se depura contra TN: si una orden ya está
      // enviada/retirada/cerrada/cancelada en TN, deja de necesitar asignación → la
      // ocultamos y la marcamos resuelta (fulfilled/cancelled) para que no reaparezca.
      if (status !== 'pending') return orders;
      const tn = await getTnClient();
      if (!tn) return orders; // sin TN no podemos verificar → mostramos lo que hay
      // Presupuesto de llamadas a TN por request: evita que un backlog grande dispare
      // cientos de getOrder en una sola carga. Las cacheadas no gastan presupuesto, así
      // que en varias cargas (con la caché) se va depurando toda la cola sin trabar.
      let budget = 30;
      const visible: typeof orders = [];
      for (const o of orders) {
        try {
          const cached = tnDoneCache.get(o.tnOrderId);
          let done: boolean;
          let curStatus = '';
          if (cached && Date.now() - cached.checkedAt < TN_DONE_TTL_MS) {
            done = cached.done;
          } else if (budget > 0) {
            budget--;
            const cur = await tn.getOrder(o.tnOrderId);
            done = tnOrderIsDone(cur);
            curStatus = String(cur?.status ?? '');
            tnDoneCache.set(o.tnOrderId, { checkedAt: Date.now(), done });
          } else {
            visible.push(o); // sin presupuesto → la mostramos, se verifica en próximas cargas
            continue;
          }
          if (done) {
            const newStatus = curStatus === 'cancelled' ? 'cancelled' : 'fulfilled';
            await prisma.tnOrderPending.update({ where: { id: o.id }, data: { status: newStatus } }).catch(() => {});
          } else {
            visible.push(o);
          }
        } catch {
          visible.push(o); // si falla la consulta a TN, no la ocultamos
        }
      }
      return visible;
    });

    r.post('/tn-orders/:id/assign', async (req) => {
      const { id } = req.params as { id: string };
      const body = z.object({ branchId: z.string(), allowNegative: z.boolean().optional() }).parse(req.body);
      const pending = await prisma.tnOrderPending.findUnique({ where: { id } });
      if (!pending) throw new Error('Pending order not found');
      if (pending.status !== 'pending') throw new Error('Order already processed');

      // Mapear items: tnVariantId -> variantId local
      const items = pending.items as any[];
      const tnVariantIds = items.map((i) => i.tnVariantId);
      const mappings = await prisma.variantTnMapping.findMany({
        where: { tnVariantId: { in: tnVariantIds } },
      });
      const mapByTn = new Map(mappings.map((m) => [m.tnVariantId, m.variantId]));
      const missing = items.filter((i) => !mapByTn.has(i.tnVariantId));
      if (missing.length > 0) {
        return { error: 'unmapped_items', missing };
      }

      // Crear venta. Ojo: en los items de la orden TN, qty/unitPrice pueden venir como
      // string ("1") en el JSON guardado → Prisma espera Int/Float y tira 500. Se castean.
      const saleItems = items.map((i) => ({
        variantId: mapByTn.get(i.tnVariantId)!,
        qty: Math.round(Number(i.qty)) || 0,
        unitPrice: Number(i.unitPrice) || 0,
      }));

      // Buscar cliente por email
      let customerId: string | null = null;
      if (pending.customerEmail) {
        const c = await prisma.customer.findFirst({ where: { email: pending.customerEmail } });
        customerId = c?.id ?? null;
      }

      // La venta debe tomar el total de los PRODUCTOS, no el total de la orden TN.
      // El total de la orden (pending.total) incluye ENVÍO/cargos que NO son venta del
      // local, así que NO se suman. Si hubo un descuento/cupón (la orden salió MENOS que
      // el subtotal de productos), sí se refleja como descuento, porque el cliente pagó
      // menos por los productos.
      const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
      const itemsSubtotal = round2(saleItems.reduce((s, it) => s + it.qty * it.unitPrice, 0));
      const diff = round2(pending.total - itemsSubtotal); // >0 = envío/cargos ; <0 = descuento
      const discountGlobalFixed = diff < 0 ? round2(-diff) : undefined;
      const saleAmount = diff < 0 ? round2(pending.total) : itemsSubtotal;

      // Guarda atómica: reclamar la orden (pending → assigning) ANTES de crear la
      // venta. Si dos asignaciones concurrentes llegan a la vez, solo una gana el
      // updateMany (count===1); la otra corta acá → no se crean dos ventas ni se
      // descuenta el stock por duplicado.
      const claim = await prisma.tnOrderPending.updateMany({
        where: { id, status: 'pending' },
        data: { status: 'assigning' },
      });
      if (claim.count !== 1) throw new ValidationError('La orden ya fue asignada o está en proceso');

      let sale;
      try {
        sale = await confirmSale(
          {
            branchId: body.branchId,
            customerId,
            items: saleItems,
            discountGlobalFixed,
            payments: [{ methodId: 'tiendanube', methodName: 'Tienda Nube', amount: saleAmount }],
            source: 'tn',
            tnOrderId: pending.tnOrderId,
          },
          { userId: req.user.userId, allowNegative: body.allowNegative },
        );
      } catch (e) {
        // Si la venta falla, liberar el lock para que el operador pueda reintentar.
        await prisma.tnOrderPending.updateMany({
          where: { id, status: 'assigning' },
          data: { status: 'pending' },
        });
        throw e;
      }

      await prisma.tnOrderPending.update({
        where: { id },
        data: {
          status: 'assigned',
          assignedBranchId: body.branchId,
          assignedSaleId: sale.id,
          assignedAt: new Date(),
        },
      });

      return { ok: true, saleId: sale.id };
    });

    // --- TN Products Pending ---
    r.get('/tn-products-pending', async (req) => {
      const q = req.query as { status?: string };
      return prisma.tnProductPending.findMany({
        where: { status: q.status ?? 'pending' },
        orderBy: { receivedAt: 'desc' },
      });
    });

    r.post('/tn-products-pending/:id/approve', adminOnly, async (req) => {
      const { id } = req.params as { id: string };
      const body = z
        .object({
          // Asignaci\u00f3n de stock por variante y sucursal
          stockAssignments: z.array(
            z.object({
              tnVariantId: z.string(),
              branchId: z.string(),
              qty: z.number().int().min(0),
            }),
          ),
          // Override opcional del costo por variante (TN no manda costo)
          costByVariant: z.record(z.number()).optional(),
        })
        .parse(req.body);

      const pending = await prisma.tnProductPending.findUnique({ where: { id } });
      if (!pending) throw new Error('Pending product not found');
      const tnProduct = pending.payload as any;

      // Crear producto local + variantes + mappings
      const productId = randomId();
      await prisma.$transaction(async (tx) => {
        await tx.product.create({
          data: {
            id: productId,
            code: tnProduct.variants?.[0]?.sku ?? `TN-${tnProduct.id}`,
            name: tnProduct.name?.es ?? 'Producto TN',
            description: tnProduct.description?.es ?? null,
            cost: 0,
            price: tnProduct.variants?.[0] ? parseFloat(tnProduct.variants[0].price) : 0,
            publishedTn: true,
          },
        });
        await tx.productTnMapping.create({
          data: {
            productId,
            tnProductId: String(tnProduct.id),
            lastPullAt: new Date(),
          },
        });
        for (const tnV of tnProduct.variants ?? []) {
          const vid = randomId();
          const attrs: Record<string, string> = {};
          (tnV.values ?? []).forEach((val: any, idx: number) => {
            const attrName = tnProduct.attributes?.[idx]?.es ?? `attr${idx + 1}`;
            attrs[attrName] = val.es ?? val;
          });
          await tx.variant.create({
            data: {
              id: vid,
              productId,
              name: (tnV.values ?? []).map((v: any) => v.es ?? v).join(' / ') || 'default',
              attributes: attrs as any,
              code: tnV.sku ?? null,
              barcode: tnV.barcode ?? null,
              priceOverride: parseFloat(tnV.price),
              costOverride: body.costByVariant?.[String(tnV.id)] ?? null,
              isDefault: (tnProduct.variants?.length ?? 0) === 1,
            },
          });
          await tx.variantTnMapping.create({
            data: {
              variantId: vid,
              tnProductId: String(tnProduct.id),
              tnVariantId: String(tnV.id),
              lastPullAt: new Date(),
            },
          });
          // Stock inicial por sucursal
          const branches = await tx.branch.findMany();
          for (const b of branches) {
            const assignment = body.stockAssignments.find(
              (a) => a.tnVariantId === String(tnV.id) && a.branchId === b.id,
            );
            await tx.stock.create({
              data: {
                id: `${vid}|${b.id}`,
                variantId: vid,
                branchId: b.id,
                qty: assignment?.qty ?? 0,
              },
            });
          }
        }
        // Descargar im\u00e1genes de TN
        // (En foreground simple: push_image_create por cada imagen)
        // Aqu\u00ed podr\u00edamos hacerlo, pero para simplificar lo dejamos como job separado.
      });

      await prisma.tnProductPending.update({
        where: { id },
        data: { status: 'approved', reviewedAt: new Date() },
      });

      // Tras aprobar, hacer push de stock (la cantidad asignada) a TN
      const variants = await prisma.variant.findMany({ where: { productId } });
      for (const v of variants) {
        await enqueueSync('push_stock', { variantId: v.id });
      }

      return { ok: true, productId };
    });

    r.post('/tn-products-pending/:id/reject', adminOnly, async (req) => {
      const { id } = req.params as { id: string };
      await prisma.tnProductPending.update({
        where: { id },
        data: { status: 'rejected', reviewedAt: new Date() },
      });
      return { ok: true };
    });

    // --- Reconciliación de stock a Tienda Nube ---
    // Encola un push_stock (SET absoluto = stock local) por cada variante de un
    // producto ENLAZADO. Corrige desincronizaciones (p.ej. tras una recarga masiva
    // donde el stock local quedó distinto al de TN). Idempotente: push_stock fija
    // el valor absoluto, no descuenta, así que correrlo varias veces es seguro.
    r.post('/resync-stock', adminOnly, async (req) => {
      const linkedProducts = await prisma.product.findMany({
        where: { tnMapping: { isNot: null }, active: true },
        select: { variants: { select: { id: true } } },
      });
      const variantIds = linkedProducts.flatMap((p) => p.variants.map((v) => v.id));
      for (const vid of variantIds) {
        await enqueueSync('push_stock', { variantId: vid });
      }
      return { ok: true, enqueued: variantIds.length, products: linkedProducts.length };
    });

    // Diff de stock para la conciliación: por cada VARIANTE ENLAZADA devuelve el
    // stock local (el que se empujaría a TN) + su tnProductId/tnVariantId. Solo
    // lectura. Los productos NO enlazados no aparecen (no tienen mapping).
    r.get('/resync-stock/diff', async () => {
      const integration = await prisma.integration.findUnique({ where: { provider: 'tiendanube' } });
      const mode = integration?.stockMode ?? 'sum';
      const products = await prisma.product.findMany({
        where: { tnMapping: { isNot: null }, active: true },
        select: {
          variants: {
            select: {
              id: true,
              stocks: { select: { branchId: true, qty: true, reservedQty: true } },
              tnMapping: { select: { tnProductId: true, tnVariantId: true } },
            },
          },
        },
      });
      const out: any[] = [];
      for (const p of products) {
        for (const v of p.variants) {
          if (!v.tnMapping) continue;
          let local = 0;
          if (mode === 'sum') local = v.stocks.reduce((s, x) => s + Math.max(0, x.qty - x.reservedQty), 0);
          else { const t = v.stocks.find((x) => x.branchId === mode); local = t ? Math.max(0, t.qty - t.reservedQty) : 0; }
          out.push({ variantId: v.id, tnProductId: v.tnMapping.tnProductId, tnVariantId: v.tnMapping.tnVariantId, localQty: local });
        }
      }
      return { count: out.length, items: out };
    });

    // Empuja stock a TN SOLO para las variantes indicadas (conciliación selectiva,
    // evita el zeroing accidental). Reusa push_stock: solo toca el número de stock.
    r.post('/resync-stock/batch', adminOnly, async (req) => {
      const body = z.object({ variantIds: z.array(z.string()).min(1) }).parse(req.body);
      for (const vid of body.variantIds) {
        await enqueueSync('push_stock', { variantId: vid });
      }
      return { ok: true, enqueued: body.variantIds.length };
    });

    // --- Sync Log ---
    r.get('/sync/log', async (req) => {
      const q = req.query as { limit?: string; status?: string };
      return prisma.tnSyncLog.findMany({
        where: q.status ? { status: q.status } : undefined,
        orderBy: { datetime: 'desc' },
        take: q.limit ? parseInt(q.limit) : 100,
      });
    });

    // --- Conflicts ---
    r.get('/sync/conflicts', async (req) => {
      const q = req.query as { status?: string };
      const { listConflicts } = await import('../sync/conflicts.js');
      return listConflicts(q.status ?? 'open');
    });

    r.post('/sync/conflicts/:id/resolve', adminOnly, async (req) => {
      const { id } = req.params as { id: string };
      const body = z.object({ resolution: z.enum(['accept', 'cancel', 'adjust']) }).parse(req.body);
      const { resolveConflict } = await import('../sync/conflicts.js');
      return resolveConflict(id, body.resolution, req.user.userId);
    });

    r.post('/sync/conflicts/:id/dismiss', adminOnly, async (req) => {
      const { id } = req.params as { id: string };
      const { dismissConflict } = await import('../sync/conflicts.js');
      return dismissConflict(id, req.user.userId);
    });
  });
}
