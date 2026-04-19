import { prisma } from '../db.js';
import { getTnClient } from './client.js';
import { findOrCreateByEmail } from '../services/customers.js';
import { processReturn } from '../services/returns.js';
import { randomId } from '../utils/crypto.js';

/**
 * Handlers de webhooks entrantes desde Tienda Nube.
 * Cada uno debe ser idempotente.
 */

export async function handleOrderPaid(event: any) {
  const tn = await getTnClient();
  if (!tn) throw new Error('TN not connected');
  const tnOrderId = String(event.id);

  // Idempotencia
  const existing = await prisma.tnOrderPending.findUnique({ where: { tnOrderId } });
  if (existing) return { skipped: 'already received' };

  const order = await tn.getOrder(tnOrderId);

  // Cliente
  if (order.customer?.email) {
    await findOrCreateByEmail(order.customer.email, {
      name: order.customer.name ?? order.customer.email,
      phone: order.customer.phone,
      email: order.customer.email,
      tnCustomerId: order.customer.id ? String(order.customer.id) : null,
    });
  }

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

  if (pending.status === 'assigned' && pending.assignedSaleId) {
    const sale = await prisma.sale.findUnique({
      where: { id: pending.assignedSaleId },
      include: { items: true },
    });
    if (sale && sale.status === 'confirmed') {
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

  await prisma.tnOrderPending.update({
    where: { tnOrderId },
    data: { status: 'cancelled' },
  });

  return { ok: true };
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
  const tn = await getTnClient();
  if (!tn) throw new Error('TN not connected');
  const tnProduct = await tn.getProduct(tnProductId);

  // Last-write-wins: si la modificaci\u00f3n de TN es posterior a la local, actualizamos
  const tnUpdated = new Date(tnProduct.updated_at);
  if (mapping.product.updatedAt > tnUpdated) {
    return { skipped: 'local newer' };
  }
  await prisma.product.update({
    where: { id: mapping.productId },
    data: {
      name: tnProduct.name?.es ?? mapping.product.name,
      description: tnProduct.description?.es ?? null,
      price: tnProduct.variants?.[0] ? parseFloat(tnProduct.variants[0].price) : mapping.product.price,
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
  await prisma.product.delete({ where: { id: mapping.productId } });
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
