import { prisma } from '../db.js';
import { randomId } from '../utils/crypto.js';
import { ValidationError } from '../utils/errors.js';

// Todas las lecturas de la caja NORMAL filtran box='register' para no mezclar la
// caja de seguridad. Los datos viejos (sin box) quedaron en 'register' por default.
export async function balance(branchId: string, box: string = 'register'): Promise<number> {
  const movements = await prisma.cashMovement.findMany({ where: { branchId, box } });
  return movements.reduce((s, m) => s + m.amountIn - m.amountOut, 0);
}

export async function listMovements(branchId: string, box: string = 'register') {
  return prisma.cashMovement.findMany({ where: { branchId, box }, orderBy: { datetime: 'asc' } });
}

export async function listExpenses(branchId: string) {
  return prisma.expense.findMany({ where: { branchId }, orderBy: { datetime: 'desc' } });
}

// Estado de la caja del día: si hubo apertura hoy y todavía no se cerró.
// Usa hora Argentina (-03:00) para el "hoy".
export async function dayStatus(branchId: string) {
  const now = new Date();
  const ar = new Date(now.getTime() - 3 * 3600 * 1000);
  const todayKey = ar.toISOString().slice(0, 10);
  const movements = await prisma.cashMovement.findMany({ where: { branchId, box: 'register' }, orderBy: { datetime: 'desc' }, take: 200 });
  const todays = movements.filter((m) => new Date(m.datetime.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10) === todayKey);
  const opened = todays.some((m) => m.type === 'opening');
  const closed = todays.some((m) => m.type === 'closing');
  return { isOpen: opened && !closed, openedToday: opened, closedToday: closed };
}

export async function move(input: {
  branchId: string;
  type: string;
  amountIn?: number;
  amountOut?: number;
  description?: string;
  refId?: string;
  userId?: string;
  box?: string;
  tx?: any;
}) {
  const client = input.tx ?? prisma;
  return client.cashMovement.create({
    data: {
      id: randomId(),
      datetime: new Date(),
      branchId: input.branchId,
      type: input.type,
      box: input.box ?? 'register',
      amountIn: input.amountIn ?? 0,
      amountOut: input.amountOut ?? 0,
      description: input.description ?? null,
      refId: input.refId ?? null,
      userId: input.userId ?? null,
    },
  });
}

// Apertura de caja: FIJA el saldo de la caja al monto que el operador cuenta
// físicamente (no lo suma). Si venía un saldo anterior (p.ej. no se cerró la caja
// el día previo), la diferencia se registra como un ajuste de reconciliación, para
// que quede el rastro y la caja arranque en el número real del cajón.
export async function openDay(branchId: string, initialAmount: number, userId?: string) {
  const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
  const target = round2(initialAmount);
  const current = round2(await balance(branchId, 'register'));
  // Si había saldo anterior distinto de 0, reconciliarlo antes de abrir.
  if (current !== 0) {
    await move({
      branchId,
      type: 'adjustment',
      amountIn: current < 0 ? -current : 0,
      amountOut: current > 0 ? current : 0,
      description: `Ajuste de apertura: saldo anterior de $${current} reconciliado al conteo físico`,
      userId,
    });
  }
  return move({
    branchId,
    type: 'opening',
    amountIn: target,
    description: 'Apertura de caja',
    userId,
  });
}

// Cierre de caja: el operador cuenta el efectivo físico. Si difiere del saldo del
// sistema, la diferencia se registra como un ARQUEO explícito (faltante/sobrante),
// no como parte del cierre — así el descuadre queda visible y auditable en vez de
// disimularse. Luego se deja una marca de cierre (monto 0) que cierra el día.
export async function closeDay(branchId: string, countedAmount: number, userId?: string) {
  const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
  const counted = round2(countedAmount);
  const current = round2(await balance(branchId, 'register'));
  const diff = round2(counted - current); // >0 sobrante ; <0 faltante
  if (diff !== 0) {
    const kind = diff < 0 ? 'FALTANTE' : 'SOBRANTE';
    await move({
      branchId,
      box: 'register',
      type: 'adjustment',
      amountIn: diff > 0 ? diff : 0,
      amountOut: diff < 0 ? -diff : 0,
      description: `Diferencia de arqueo (${kind} $${Math.abs(diff)}) — contado $${counted} vs sistema $${current}`,
      userId,
    });
  }
  return move({
    branchId,
    box: 'register',
    type: 'closing',
    amountIn: 0,
    amountOut: 0,
    description: `Cierre de caja — contado $${counted}${diff !== 0 ? `, diferencia $${diff}` : ' (sin diferencia)'}`,
    userId,
  });
}

export async function addExpense(input: {
  branchId: string;
  amount: number;
  category?: string;
  description?: string;
  paymentMethodId?: string;
  userId?: string;
}) {
  const expense = await prisma.expense.create({
    data: {
      id: randomId(),
      datetime: new Date(),
      branchId: input.branchId,
      amount: input.amount,
      category: input.category ?? null,
      description: input.description ?? null,
      paymentMethodId: input.paymentMethodId ?? null,
      userId: input.userId ?? null,
    },
  });
  // Solo impacta la caja si el gasto se pagó en efectivo.
  const isCash = ['cash', 'efectivo', 'efvo'].includes((input.paymentMethodId ?? 'cash').toLowerCase());
  if (isCash) {
    await move({
      branchId: input.branchId,
      type: 'expense',
      amountOut: input.amount,
      description: input.description ?? input.category ?? 'Gasto',
      refId: expense.id,
      userId: input.userId,
    });
  }
  return expense;
}

// ===================== CAJA DE SEGURIDAD (fuerte) =====================
// Segunda caja por sucursal, con saldo propio y persistente (no se cierra a
// diario). Movimientos con box='safe'. El efectivo entra depositando desde la
// caja normal y vuelve retirando; también se registran gastos y reajustes.

export async function safeBalance(branchId: string): Promise<number> {
  return balance(branchId, 'safe');
}

export async function listSafeMovements(branchId: string) {
  return prisma.cashMovement.findMany({ where: { branchId, box: 'safe' }, orderBy: { datetime: 'desc' }, take: 500 });
}

// Depósito: saca de la caja normal y entra a la de seguridad (2 movimientos atómicos).
export async function depositToSafe(input: { branchId: string; amount: number; description?: string; userId?: string }) {
  const amount = Math.round((input.amount + Number.EPSILON) * 100) / 100;
  if (!(amount > 0)) throw new ValidationError('El monto del depósito debe ser mayor a 0');
  const reg = await balance(input.branchId, 'register');
  if (amount > reg + 0.01) throw new ValidationError(`No hay tanto efectivo en la caja normal (disponible $${reg})`);
  const desc = input.description?.trim() || 'Depósito a caja de seguridad';
  return prisma.$transaction(async (tx) => {
    const ref = randomId();
    await move({ branchId: input.branchId, box: 'register', type: 'safe_deposit', amountOut: amount, description: desc, refId: ref, userId: input.userId, tx });
    await move({ branchId: input.branchId, box: 'safe', type: 'deposit', amountIn: amount, description: desc, refId: ref, userId: input.userId, tx });
    return { ok: true, amount };
  });
}

// Retiro: saca de la caja de seguridad y vuelve a la caja normal.
export async function withdrawFromSafe(input: { branchId: string; amount: number; description?: string; userId?: string }) {
  const amount = Math.round((input.amount + Number.EPSILON) * 100) / 100;
  if (!(amount > 0)) throw new ValidationError('El monto del retiro debe ser mayor a 0');
  const safe = await balance(input.branchId, 'safe');
  if (amount > safe + 0.01) throw new ValidationError(`No hay tanto en la caja de seguridad (disponible $${safe})`);
  const desc = input.description?.trim() || 'Retiro de caja de seguridad';
  return prisma.$transaction(async (tx) => {
    const ref = randomId();
    await move({ branchId: input.branchId, box: 'safe', type: 'safe_withdraw', amountOut: amount, description: desc, refId: ref, userId: input.userId, tx });
    await move({ branchId: input.branchId, box: 'register', type: 'safe_withdraw', amountIn: amount, description: desc, refId: ref, userId: input.userId, tx });
    return { ok: true, amount };
  });
}

// Gasto pagado desde la caja de seguridad (sale plata de la fuerte).
export async function addSafeExpense(input: { branchId: string; amount: number; category?: string; description?: string; userId?: string }) {
  const amount = Math.round((input.amount + Number.EPSILON) * 100) / 100;
  if (!(amount > 0)) throw new ValidationError('El monto del gasto debe ser mayor a 0');
  const safe = await balance(input.branchId, 'safe');
  if (amount > safe + 0.01) throw new ValidationError(`No hay tanto en la caja de seguridad (disponible $${safe})`);
  const desc = input.description?.trim() || input.category?.trim() || 'Gasto de caja de seguridad';
  return move({ branchId: input.branchId, box: 'safe', type: 'expense', amountOut: amount, description: desc, userId: input.userId });
}

// Reajuste: pone el saldo de la caja de seguridad en el valor real indicado,
// registrando la diferencia como un ajuste (positivo o negativo).
export async function adjustSafeBalance(input: { branchId: string; targetBalance: number; description?: string; userId?: string }) {
  const target = Math.round((input.targetBalance + Number.EPSILON) * 100) / 100;
  const current = await balance(input.branchId, 'safe');
  const delta = Math.round((target - current + Number.EPSILON) * 100) / 100;
  if (delta === 0) return { ok: true, delta: 0, balance: current };
  const desc = input.description?.trim() || `Reajuste de saldo (de $${current} a $${target})`;
  await move({
    branchId: input.branchId, box: 'safe', type: 'adjustment',
    amountIn: delta > 0 ? delta : 0, amountOut: delta < 0 ? -delta : 0,
    description: desc, userId: input.userId,
  });
  return { ok: true, delta, balance: target };
}
