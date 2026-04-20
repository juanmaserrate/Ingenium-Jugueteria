// Números correlativos (ventas, devoluciones, transferencias, vales).
// D-6: soporte de correlativos por año (AFIP exige reset anual).
import { get, put } from '../core/db.js';

// Compatibilidad hacia atrás: correlativo "global" sin reset.
export async function next(name) {
  const c = (await get('counters', name)) || { name, value: 0 };
  c.value = (c.value || 0) + 1;
  await put('counters', c);
  return c.value;
}

// D-6: correlativo que resetea al cambiar de año.
// Clave interna: `${name}_${YYYY}`. Devuelve { year, seq, label } listo para formatear.
export async function nextYearly(name, refDate = new Date()) {
  const year = refDate.getFullYear();
  const key = `${name}_${year}`;
  const c = (await get('counters', key)) || { name: key, value: 0, year };
  c.value = (c.value || 0) + 1;
  c.year = year;
  await put('counters', c);
  return { year, seq: c.value, label: `${year}-${String(c.value).padStart(6, '0')}` };
}

export async function peekYearly(name, refDate = new Date()) {
  const year = refDate.getFullYear();
  const c = await get('counters', `${name}_${year}`);
  return { year, seq: c?.value || 0 };
}
