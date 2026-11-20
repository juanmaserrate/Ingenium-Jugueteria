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

// Valida y limpia el texto de una respuesta: sin espacios sobrantes, no vacío y dentro del
// tope de ML. Tira ValidationError con un mensaje para mostrarle al operador.
export function cleanAnswerText(raw: unknown): string {
  const text = String(raw ?? '').replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
  if (!text) throw new ValidationError('Escribí la respuesta antes de enviarla');
  if (text.length > ANSWER_MAX_CHARS) throw new ValidationError(`La respuesta es muy larga: ${text.length} caracteres (máximo ${ANSWER_MAX_CHARS})`);
  return text;
}
