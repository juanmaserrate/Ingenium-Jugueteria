import { prisma } from '../db.js';
import { randomId } from '../utils/crypto.js';

// Notificaciones push para la app móvil (Expo). El dispositivo registra su ExponentPushToken
// al iniciar sesión; al confirmarse una venta se envía un aviso a todos los registrados.
// Todo es best-effort: nunca frena una venta.

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

const isExpoToken = (t: string) => /^Expo(nent)?PushToken\[.+\]$/.test(t);

export async function registerPushToken(input: {
  token: string; userId?: string | null; branchId?: string | null; platform?: string | null;
}) {
  const token = String(input.token || '').trim();
  if (!isExpoToken(token)) throw new Error('Token push inválido');
  const existing = await prisma.pushToken.findUnique({ where: { token } });
  if (existing) {
    await prisma.pushToken.update({
      where: { token },
      data: {
        userId: input.userId ?? existing.userId,
        branchId: input.branchId ?? existing.branchId,
        platform: input.platform ?? existing.platform,
      },
    });
    return { ok: true, updated: true };
  }
  await prisma.pushToken.create({
    data: { id: randomId(), token, userId: input.userId ?? null, branchId: input.branchId ?? null, platform: input.platform ?? null },
  });
  return { ok: true, created: true };
}

export async function unregisterPushToken(token: string) {
  await prisma.pushToken.deleteMany({ where: { token } });
  return { ok: true };
}

// Envía un aviso a TODOS los dispositivos registrados (el dueño quiere ver ambas sucursales).
// Limpia los tokens que Expo reporta como DeviceNotRegistered. Best-effort.
export async function notifySalePush(info: {
  number: number | string; branchName: string; total: number; source?: string | null; itemsCount?: number;
}) {
  let tokens: Array<{ token: string }>;
  try { tokens = await prisma.pushToken.findMany({ select: { token: true } }); } catch { return; }
  if (!tokens.length) return;

  const canal = info.source === 'tn' ? 'Tienda Nube' : info.source === 'ml' ? 'Mercado Libre' : 'Local';
  const monto = `$${Number(info.total || 0).toLocaleString('es-AR')}`;
  const items = info.itemsCount ? ` · ${info.itemsCount} ítem${info.itemsCount === 1 ? '' : 's'}` : '';
  const body = `${info.branchName} · ${monto}${items} · ${canal}`;

  const messages = tokens.map((t) => ({
    to: t.token,
    sound: 'default',
    title: `Venta #${info.number}`,
    body,
    data: { type: 'sale', number: String(info.number), branch: info.branchName },
    channelId: 'ventas',
    priority: 'high',
  }));

  // Expo acepta hasta 100 mensajes por request.
  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100);
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(chunk),
      });
      const json: any = await res.json().catch(() => null);
      const data = json?.data;
      if (Array.isArray(data)) {
        for (let k = 0; k < data.length; k++) {
          if (data[k]?.status === 'error' && data[k]?.details?.error === 'DeviceNotRegistered') {
            await prisma.pushToken.deleteMany({ where: { token: chunk[k].to } }).catch(() => {});
          }
        }
      }
    } catch (err: any) {
      console.warn('[push] fallo al enviar a Expo:', err?.message);
    }
  }
}
