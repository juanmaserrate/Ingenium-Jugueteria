// Formatos consistentes (moneda AR, fechas, horas).

export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export const money = (n, withSymbol = true) => {
  const v = Number(n || 0);
  const s = v.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return withSymbol ? `$\u00A0${s}` : s;
};

export const pct = (n, d = 2) => `${Number(n || 0).toFixed(d)}%`;

export const fmtDate = (d) => {
  if (!d) return '';
  const x = d instanceof Date ? d : new Date(d);
  return x.toLocaleDateString('es-AR'); // dd/mm/yyyy
};

export const fmtDateShort = (d) => {
  if (!d) return '';
  const x = d instanceof Date ? d : new Date(d);
  const dd = String(x.getDate()).padStart(2, '0');
  const mm = String(x.getMonth() + 1).padStart(2, '0');
  const yy = String(x.getFullYear()).slice(-2);
  return `${dd}-${mm}-${yy}`;
};

export const fmtDateTime = (d) => {
  if (!d) return '';
  const x = d instanceof Date ? d : new Date(d);
  return x.toLocaleString('es-AR');
};

export const nowIso = () => new Date().toISOString();
export const todayKey = () => new Date().toISOString().slice(0, 10); // YYYY-MM-DD
export const monthKey = (d = new Date()) => {
  const x = d instanceof Date ? d : new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`;
};
export const yearKey = (d = new Date()) => String((d instanceof Date ? d : new Date(d)).getFullYear());

// Horas entre dos HH:MM — devuelve "H:MM"
export const hoursBetween = (checkIn, checkOut) => {
  if (!checkIn || !checkOut) return '0:00';
  const [h1, m1] = checkIn.split(':').map(Number);
  const [h2, m2] = checkOut.split(':').map(Number);
  let mins = (h2 * 60 + m2) - (h1 * 60 + m1);
  if (mins < 0) mins += 24 * 60;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
};

export const hoursDecimal = (checkIn, checkOut) => {
  if (!checkIn || !checkOut) return 0;
  const [h1, m1] = checkIn.split(':').map(Number);
  const [h2, m2] = checkOut.split(':').map(Number);
  let mins = (h2 * 60 + m2) - (h1 * 60 + m1);
  if (mins < 0) mins += 24 * 60;
  return mins / 60;
};

// Aplica descuento/recargo. rule = { pct?: n, fixed?: n } (pct sobre el base)
export const applyDiscount = (base, pct = 0, fixed = 0) => {
  const afterPct = base * (1 - pct / 100);
  return Math.max(0, afterPct - fixed);
};
export const applySurcharge = (base, pct = 0, fixed = 0) => {
  const afterPct = base * (1 + pct / 100);
  return afterPct + fixed;
};
