// Lógica PURA (sin base ni red) de las preguntas de Mercado Libre: testeable en
// backend/tests/ml.test.ts.

import { ValidationError } from '../utils/errors.js';

export const ANSWER_MAX_CHARS = 2000; // tope de Mercado Libre para una respuesta

export type MlQuestionView = {
  id: string;
  text: string;
  status: string;
  dateCreated: string | null;
  itemId: string | null;
  buyerId: string | null;
  answer: { text: string; dateCreated: string | null } | null;
};

// Pasa una pregunta cruda de ML a lo que usa la pantalla. Devuelve null si no trae id o si
// fue eliminada/moderada (no se puede responder y no aporta nada verla).
export function normalizeQuestion(q: any): MlQuestionView | null {
  if (!q || q.id == null) return null;
  const status = String(q.status ?? '');
  if (status === 'BANNED' || status === 'DELETED' || q.deleted_from_listing === true) return null;
  const ans = q.answer && typeof q.answer === 'object' && q.answer.text ? q.answer : null;
  return {
    id: String(q.id),
    text: String(q.text ?? ''),
    status,
    dateCreated: q.date_created ? String(q.date_created) : null,
    itemId: q.item_id ? String(q.item_id) : null,
    buyerId: q.from?.id != null ? String(q.from.id) : null,
    answer: ans ? { text: String(ans.text), dateCreated: ans.date_created ? String(ans.date_created) : null } : null,
  };
}

// --- Envíos Flex: pasa la respuesta de ML (rangos de entrega) a algo legible ---
export type FlexDay = { day: 'week' | 'saturday' | 'sunday'; label: string; works: boolean; ranges: Array<{ from: number | null; to: number | null; cutoff: number | null; capacity: number | null }> };

const FLEX_DAYS: Array<[FlexDay['day'], string]> = [['week', 'Lunes a viernes'], ['saturday', 'Sábados'], ['sunday', 'Domingos']];
const hour = (v: unknown) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// Un día sin rangos configurados = ese día no se despacha por Flex.
export function flexSchedule(deliveryRanges: any): FlexDay[] {
  return FLEX_DAYS.map(([day, label]) => {
    const raw = Array.isArray(deliveryRanges?.[day]) ? deliveryRanges[day] : [];
    const ranges = raw.map((r: any) => ({ from: hour(r?.from), to: hour(r?.to), cutoff: hour(r?.cutoff), capacity: hour(r?.capacity) }));
    return { day, label, works: ranges.length > 0, ranges };
  });
}

// Valida y limpia el texto de una respuesta: sin espacios sobrantes, no vacío y dentro del
// tope de ML. Tira ValidationError con un mensaje para mostrarle al operador.
export function cleanAnswerText(raw: unknown): string {
  const text = String(raw ?? '').replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
  if (!text) throw new ValidationError('Escribí la respuesta antes de enviarla');
  if (text.length > ANSWER_MAX_CHARS) throw new ValidationError(`La respuesta es muy larga: ${text.length} caracteres (máximo ${ANSWER_MAX_CHARS})`);
  return text;
}
