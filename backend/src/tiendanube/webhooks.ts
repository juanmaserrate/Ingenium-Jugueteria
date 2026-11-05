import { prisma } from '../db.js';
import { Prisma } from '@prisma/client';
import { getTnClient } from './client.js';
import { findOrCreateByEmail } from '../services/customers.js';
import { processReturn } from '../services/returns.js';
import { randomId } from '../utils/crypto.js';

/**
 * Handlers de webhooks entrantes desde Tienda Nube.
 * Cada uno debe ser idempotente.
 */

// Ventana anti-eco: si empujamos algo a TN hace menos que esto, el webhook product/updated
// que llega es el reflejo de nuestro propio push y lo ignoramos (ver handleProductUpdated).
const ECHO_WINDOW_MS = 2 * 60 * 1000;

export async function handleOrderPaid(event: any) {
  const tn = await getTnClient();
  if (!tn) throw new Error('TN not connected');
  const tnOrderId = String(event.id);

  // Idempotencia
  const existing = await prisma.tnOrderPending.findUnique({ where: { tnOrderId } });
  if (existing) return { skipped: 'already received' };

  const order = await tn.getOrder(tnOrderId);
  return ingestPaidOrder(order);
}

/**
 * Crea la orden pendiente local + la notificación a partir de una orden de TN ya
 * traída. Idempotente por tnOrderId. Lo usa el webhook `order/paid` y el respaldo
 * (reconcileTnOrders) que lista las pagadas desde la API por si se perdió un webhook.
 */
export async function ingestPaidOrder(order: any) {
  const tnOrderId = String(order.id);
  const existing = await prisma.tnOrderPending.findUnique({ where: { tnOrderId } });
  if (existing) return { skipped: 'already received' };

  // Cliente
  if (order.customer?.email) {
    await findOrCreateByEmail(order.customer.email, {
      name: order.customer.name ?? order.customer.email,
      phone: order.customer.phone,
      email: order.customer.email,
      tnCustomerId: order.customer.id ? String(order.customer.id) : null,
    });
  }

  try {
    await prisma.tnOrderPending.create({
      data: {
        tnOrderId,
        number: order.number ? String(order.number) : null,
        customerName: order.customer?.name ?? 'Sin nombre',
        customerEmail: order.customer?.email ?? null,
        customerPhone: order.customer?.phone ?? null,
        items: (order.products ?? []).map((p: any) => ({
          tnProductId: String(p.product_id),
          tnVariantId: String(p.variant_id),
          qty: p.quantity,
          unitPrice: parseFloat(p.price),
          productName: p.name,
          variantName: p.variant_values?.join(' / ') ?? null,
        })) as any,
        total: parseFloat(order.total ?? '0'),
        currency: order.currency ?? 'ARS',
        paymentStatus: order.payment_status ?? 'paid',
        rawPayload: order,
        status: 'pending',
      },
    });
  } catch (e) {
    // Carrera: si dos webhooks 'order/paid' de la misma orden llegan a la vez, el
    // segundo choca contra el unique de tnOrderId → lo tratamos como ya recibido.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return { skipped: 'already received (race)' };
    }
    throw e;
  }

  // Notificaci\u00f3n
  await prisma.notification.create({
    data: {
      id: randomId(),
      type: 'tn_order',
      title: 'Nueva venta de Tienda Nube',
      message: `Orden #${order.number ?? tnOrderId} - $${order.total}. Asignar sucursal.`,
      data: { tnOrderId } as any,
    },
  });

  return { ok: true, tnOrderId };
}

export async function handleOrderCancelled(event: any) {
  const tnOrderId = String(event.id);
  // Si la orden ya fue asignada a una venta en Ingenium, crear devoluci\u00f3n autom\u00e1tica
  const pending = await prisma.tnOrderPending.findUnique({ where: { tnOrderId } });
  if (!pending) return { skipped: 'unknown order' };

  // Guarda at\u00f3mica: un solo handler gana el pasaje a 'cancelled'. Evita que dos
  // webhooks 'order/cancelled' (o reintentos de TN) generen la devoluci\u00f3n dos veces.
  const flip = await prisma.tnOrderPending.updateMany({
    where: { tnOrderId, status: { not: 'cancelled' } },
    data: { status: 'cancelled' },
  });
  if (flip.count !== 1) return { skipped: 'already cancelled' };

  if (pending.status === 'assigned' && pending.assignedSaleId) {
    const sale = await prisma.sale.findUnique({
      where: { id: pending.assignedSaleId },
      include: { items: true },
    });
    if (sale && sale.status === 'confirmed') {
      // processReturn ya valida qty \u2264 vendida y deduplica contra devoluciones previas,
      // as\u00ed que incluso ante un reintento no reembolsa de m\u00e1s.
      await processReturn({
        branchId: sale.branchId,
        originalSaleId: sale.id,
        customerId: sale.customerId,
        returnedItems: sale.items.map((it) => ({
          variantId: it.variantId,
          qty: it.qty,
          unitPrice: it.unitPrice,
        })),
        takenItems: [],
        reason: `Orden TN #${tnOrderId} cancelada`,
        source: 'tn_cancelled',
        tnOrderId,
      });
    }
  }

  return { ok: true };
}

// Mapea los ítems de una orden de TN al formato que guardamos en tnOrderPending.
function mapTnItems(order: any) {
  return (order.products ?? []).map((p: any) => ({
    tnProductId: String(p.product_id),
    tnVariantId: String(p.variant_id),
    qty: p.quantity,
    unitPrice: parseFloat(p.price),
    productName: p.name,
    variantName: p.variant_values?.join(' / ') ?? null,
  }));
}

// Firma estable de una orden (ítems + total) para detectar si REALMENTE cambió.
function orderSig(items: any, total: any): string {
  const arr = (Array.isArray(items) ? items : []).map((x: any) => `${x.tnVariantId}:${x.qty}:${x.unitPrice}`).sort();
  return JSON.stringify({ t: Number(total) || 0, i: arr });
}

// Refresca la foto de una orden PENDIENTE (aún sin asignar) con los datos actuales de TN.
// Lo usan el webhook order/updated (orden completa → updateRaw) y el respaldo reconcile
// (orden del listado, más liviana → NO pisa rawPayload, que el costo de asignación necesita).
// No toca órdenes ya asignadas o canceladas. Devuelve {changed} si hubo diferencias.
export async function refreshPendingOrderSnapshot(order: any, { updateRaw = true }: { updateRaw?: boolean } = {}) {
  const tnOrderId = String(order.id);
  const pending = await prisma.tnOrderPending.findUnique({ where: { tnOrderId } });
  if (!pending || pending.status !== 'pending') return { skipped: 'not pending' };
  const items = mapTnItems(order);
  const total = parseFloat(order.total ?? '0');
  if (orderSig(pending.items, pending.total) === orderSig(items, total)) return { skipped: 'unchanged' };
  await prisma.tnOrderPending.update({
    where: { tnOrderId },
    data: {
      number: order.number ? String(order.number) : pending.number,
      customerName: order.customer?.name ?? pending.customerName,
      customerEmail: order.customer?.email ?? pending.customerEmail,
      customerPhone: order.customer?.phone ?? pending.customerPhone,
      items: items as any,
      total,
      currency: order.currency ?? pending.currency,
      paymentStatus: order.payment_status ?? pending.paymentStatus,
      ...(updateRaw ? { rawPayload: order } : {}),
    },
  });
  return { ok: true, changed: true, tnOrderId };
}

// order/updated: TN editó una orden (p.ej. cancelás un ítem → cancelación parcial). Si la
// tenemos pendiente, refrescamos la foto; si TN la marcó cancelada, delegamos al handler de
// cancelación; si todavía no la teníamos y ya está pagada, la ingresamos (como paid perdido).
export async function handleOrderUpdated(event: any) {
  const tnOrderId = String(event.id);
  const tn = await getTnClient();
  if (!tn) throw new Error('TN not connected');
  const order = await tn.getOrder(tnOrderId);

  if (order.status === 'cancelled' || order.cancelled_at) return handleOrderCancelled({ id: tnOrderId });

  const pending = await prisma.tnOrderPending.findUnique({ where: { tnOrderId } });
  if (!pending) {
    if (order.payment_status === 'paid') return ingestPaidOrder(order);
    return { skipped: 'order not received yet' };
  }
  if (pending.status !== 'pending') return { skipped: `order ${pending.status}` };
  return refreshPendingOrderSnapshot(order);
}

export async function handleProductCreated(event: any) {
  const tnProductId = String(event.id);
  // \u00bfYa existe mapping? → lo creamos nosotros, ignoramos
  const existing = await prisma.productTnMapping.findUnique({ where: { tnProductId } });
  if (existing) return { skipped: 'already mapped' };

  const pending = await prisma.tnProductPending.findUnique({ where: { tnProductId } });
  if (pending) return { skipped: 'already pending' };

  const tn = await getTnClient();
  if (!tn) throw new Error('TN not connected');
  const product = await tn.getProduct(tnProductId);

  await prisma.tnProductPending.create({
    data: {
      tnProductId,
      payload: product,
      status: 'pending',
    },
  });

  await prisma.notification.create({
    data: {
      id: randomId(),
      type: 'tn_product',
      title: 'Producto nuevo de Tienda Nube',
      message: `${product.name?.es ?? tnProductId} requiere asignaci\u00f3n de stock`,
      data: { tnProductId } as any,
    },
  });

  return { ok: true };
}

export async function handleProductUpdated(event: any) {
  const tnProductId = String(event.id);
  const mapping = await prisma.productTnMapping.findUnique({
    where: { tnProductId },
    include: { product: true },
  });
  if (!mapping) {
    // Si no hay mapping, lo tratamos como producto nuevo
    return handleProductCreated(event);
  }

  // Anti-eco: cada push nuestro a TN (producto/variante/stock) bump-ea el updated_at de TN,
  // que a su vez dispara este mismo webhook product/updated. Sin esta guarda, termin\u00e1bamos
  // "pulleando" de vuelta lo que acab\u00e1bamos de empujar (el revert de precio del Carrusel).
  // Si hubo un push propio hace menos de ECHO_WINDOW_MS, ignoramos el webhook: es el eco.
  const variantPushes = await prisma.variantTnMapping.findMany({
    where: { tnProductId },
    select: { lastPushAt: true },
  });
  const lastPush = Math.max(
    mapping.lastPushAt?.getTime() ?? 0,
    ...variantPushes.map((v) => v.lastPushAt?.getTime() ?? 0),
  );
  if (lastPush && Date.now() - lastPush < ECHO_WINDOW_MS) {
    return { skipped: 'echo of recent local push' };
  }

  const tn = await getTnClient();
  if (!tn) throw new Error('TN not connected');
  const tnProduct = await tn.getProduct(tnProductId);

  // Last-write-wins: si la modificaci\u00f3n de TN es posterior a la local, actualizamos.
  // Si la fecha de TN es inv\u00e1lida, NO tocamos nada (no arriesgamos pisar lo local).
  const tnUpdated = new Date(tnProduct.updated_at);
  if (Number.isNaN(tnUpdated.getTime()) || mapping.product.updatedAt > tnUpdated) {
    return { skipped: 'local newer or invalid date' };
  }
  await prisma.product.update({
    where: { id: mapping.productId },
    data: {
      name: tnProduct.name?.es ?? mapping.product.name,
      // No pisar la descripci\u00f3n local con null si TN no la trae.
      description: tnProduct.description?.es ?? mapping.product.description,
      // El PRECIO siempre sale del sistema: nunca lo pisamos con el de TN. Traer el precio
      // de TN ac\u00e1 era la otra mitad del revert (TN tiene el precio viejo tras el eco).
    },
  });
  await prisma.productTnMapping.update({
    where: { productId: mapping.productId },
    data: { lastPullAt: new Date() },
  });
  return { ok: true };
}

export async function handleProductDeleted(event: any) {
  const tnProductId = String(event.id);
  const mapping = await prisma.productTnMapping.findUnique({ where: { tnProductId } });
  if (!mapping) return { skipped: 'unknown' };
  // Si el producto tiene historial de ventas/compras, un hard-delete viola las FK de
  // SaleItem/PurchaseItem y el webhook tira 500 → TN reintenta en loop. Soft-delete.
  const variants = await prisma.variant.findMany({ where: { productId: mapping.productId }, select: { id: true } });
  const variantIds = variants.map((v) => v.id);
  const [sales, purchases] = await Promise.all([
    prisma.saleItem.count({ where: { variantId: { in: variantIds } } }),
    prisma.purchaseItem.count({ where: { variantId: { in: variantIds } } }),
  ]);
  if (sales > 0 || purchases > 0) {
    await prisma.product.update({ where: { id: mapping.productId }, data: { active: false } });
  } else {
    await prisma.product.delete({ where: { id: mapping.productId } });
  }
  return { ok: true };
}

export async function handleCustomerCreated(event: any) {
  const tnCustomerId = String(event.id);
  const existing = await prisma.customer.findUnique({ where: { tnCustomerId } });
  if (existing) return { skipped: 'already synced' };

  const tn = await getTnClient();
  if (!tn) throw new Error('TN not connected');
  const customer = await tn.getCustomer(tnCustomerId);

  if (!customer.email) {
    // No podemos deduplicar sin email, creamos sin v\u00ednculo
    await findOrCreateByEmail('', {
      name: customer.name ?? 'Cliente TN',
      phone: customer.phone,
      tnCustomerId,
    });
    return { ok: true };
  }

  await findOrCreateByEmail(customer.email, {
    name: customer.name ?? customer.email,
    email: customer.email,
    phone: customer.phone,
    tnCustomerId,
    documentNumber: customer.identification,
    address: customer.default_address?.address,
    city: customer.default_address?.city,
  });

  return { ok: true };
}

export async function dispatchWebhook(event: string, body: any) {
  switch (event) {
    case 'order/paid':
      return handleOrderPaid(body);
    case 'order/updated':
      return handleOrderUpdated(body);
    case 'order/cancelled':
      return handleOrderCancelled(body);
    case 'product/created':
      return handleProductCreated(body);
    case 'product/updated':
      return handleProductUpdated(body);
    case 'product/deleted':
      return handleProductDeleted(body);
    case 'customer/created':
      return handleCustomerCreated(body);
    default:
      return { skipped: `unknown event: ${event}` };
  }
}
