import { prisma } from '../db.js';
import { requireMlClient, getMlClient, MlClient } from './client.js';
import { ValidationError } from '../utils/errors.js';
import { cleanAnswerText, normalizeQuestion, type MlQuestionView } from './questionsPure.js';

// Preguntas de compradores en las publicaciones de Mercado Libre ("pre-venta").
// No se guardan en la base: se leen EN VIVO de ML (la fuente de verdad) y la respuesta se
// publica en ML. Lo único que se cachea, en memoria, es el contador del menú y los datos de
// cada publicación (título/foto), para no pegarle a ML en cada refresco de pantalla.

export type QuestionStatus = 'UNANSWERED' | 'ANSWERED';

type ItemInfo = { title: string; permalink: string | null; thumbnail: string | null; price: number | null; availableQty: number | null; status: string | null };

const ITEM_TTL_MS = 10 * 60_000;
const itemCache = new Map<string, { at: number; v: ItemInfo | null }>();

async function itemInfo(ml: MlClient, itemId: string): Promise<ItemInfo | null> {
  const hit = itemCache.get(itemId);
  if (hit && Date.now() - hit.at < ITEM_TTL_MS) return hit.v;
  let v: ItemInfo | null = null;
  try {
    const it: any = await ml.getItem(itemId);
    v = {
      title: String(it?.title ?? ''),
      permalink: it?.permalink ?? null,
      // ML suele mandar la miniatura en http: se pasa a https (mismo servidor) para que el
      // navegador la muestre dentro del sistema.
      thumbnail: String(it?.secure_thumbnail ?? it?.thumbnail ?? '').replace(/^http:\/\//i, 'https://') || null,
      price: it?.price != null ? Number(it.price) : null,
      availableQty: it?.available_quantity != null ? Number(it.available_quantity) : null,
      status: it?.status ?? null,
    };
  } catch { /* publicación borrada o sin acceso: la pregunta se muestra igual, sin ficha */ }
  itemCache.set(itemId, { at: Date.now(), v });
  return v;
}

type ProductInfo = {
  id: string; name: string; code: string; price: number;
  stockTotal: number;
  stockByBranch: Array<{ branch: string; qty: number }>;
  variants: Array<{ name: string; qty: number }>; // solo si la publicación tiene más de una
};

// Producto del sistema vinculado a cada publicación (por el vínculo de variantes; si no hay,
// por el vínculo de producto). Stock = lo disponible (qty − reservado) por sucursal.
async function linkedProducts(itemIds: string[]): Promise<Map<string, ProductInfo>> {
  const out = new Map<string, ProductInfo>();
  if (!itemIds.length) return out;
  const variantSel = { id: true, name: true, isDefault: true, stocks: { select: { branchId: true, qty: true, reservedQty: true } } } as const;
  const productSel = { id: true, name: true, code: true, price: true, promotionalPrice: true } as const;

  const [vMaps, pMaps, branches] = await Promise.all([
    prisma.variantMeliMapping.findMany({
      where: { mlItemId: { in: itemIds } },
      select: { mlItemId: true, variant: { select: { ...variantSel, product: { select: productSel } } } },
    }),
    prisma.productMeliMapping.findMany({
      where: { mlItemId: { in: itemIds } },
      select: { mlItemId: true, product: { select: { ...productSel, variants: { select: variantSel } } } },
    }),
    prisma.branch.findMany({ select: { id: true, name: true } }),
  ]);
  const branchName = new Map(branches.map((b) => [b.id, b.name]));

  const build = (product: { id: string; name: string; code: string; price: number; promotionalPrice: number | null }, variants: Array<{ name: string; stocks: Array<{ branchId: string; qty: number; reservedQty: number }> }>): ProductInfo => {
    const byBranch = new Map<string, number>();
    const perVariant: Array<{ name: string; qty: number }> = [];
    for (const v of variants) {
      let vq = 0;
      for (const s of v.stocks) {
        const q = Math.max(0, s.qty - s.reservedQty);
        vq += q;
        byBranch.set(s.branchId, (byBranch.get(s.branchId) ?? 0) + q);
      }
      perVariant.push({ name: v.name, qty: vq });
    }
    return {
      id: product.id, name: product.name, code: product.code,
      price: product.promotionalPrice && product.promotionalPrice > 0 ? product.promotionalPrice : product.price,
      stockTotal: perVariant.reduce((s, v) => s + v.qty, 0),
      stockByBranch: branches.map((b) => ({ branch: branchName.get(b.id) ?? b.id, qty: byBranch.get(b.id) ?? 0 })),
      variants: perVariant.length > 1 ? perVariant : [],
    };
  };

  const byItem = new Map<string, typeof vMaps>();
  for (const m of vMaps) { const a = byItem.get(m.mlItemId) ?? []; a.push(m); byItem.set(m.mlItemId, a); }
  for (const [itemId, maps] of byItem) out.set(itemId, build(maps[0].variant.product, maps.map((m) => m.variant)));
  for (const m of pMaps) if (!out.has(m.mlItemId)) out.set(m.mlItemId, build(m.product, m.product.variants));
  return out;
}

async function sellerId(): Promise<string> {
  const integ = await prisma.integration.findUnique({ where: { provider: 'mercadolibre' } });
  if (!integ?.mlUserId) throw new ValidationError('Mercado Libre no está conectado');
  return integ.mlUserId;
}

export type QuestionRow = MlQuestionView & { item: ItemInfo | null; product: ProductInfo | null };

export async function listQuestions(status: QuestionStatus, limit = 50): Promise<{ total: number; questions: QuestionRow[] }> {
  const ml = await requireMlClient();
  const res: any = await ml.searchQuestions({
    seller_id: await sellerId(), status, api_version: 4,
    sort_fields: 'date_created', sort_types: 'DESC', limit: Math.min(50, Math.max(1, limit)),
  });
  const qs = (Array.isArray(res?.questions) ? res.questions : []).map(normalizeQuestion).filter((q: MlQuestionView | null): q is MlQuestionView => !!q);
  const itemIds = [...new Set(qs.map((q: MlQuestionView) => q.itemId).filter(Boolean))] as string[];
  const [products, items] = await Promise.all([
    linkedProducts(itemIds),
    Promise.all(itemIds.map(async (id) => [id, await itemInfo(ml, id)] as const)),
  ]);
  const itemMap = new Map(items);
  if (status === 'UNANSWERED') setCount(Number(res?.total) || qs.length);
  return {
    total: Number(res?.total) || qs.length,
    questions: qs.map((q: MlQuestionView) => ({ ...q, item: (q.itemId && itemMap.get(q.itemId)) || null, product: (q.itemId && products.get(q.itemId)) || null })),
  };
}

// --- Contador del menú (cacheado 60 s; se invalida al responder o al llegar un aviso de ML) ---
const COUNT_TTL_MS = 60_000;
let countCache: { at: number; n: number } | null = null;
function setCount(n: number) { countCache = { at: Date.now(), n }; }
export function invalidateQuestionsCount() { countCache = null; }

export async function countUnanswered(): Promise<number> {
  if (countCache && Date.now() - countCache.at < COUNT_TTL_MS) return countCache.n;
  const ml = await getMlClient();
  if (!ml) return 0;
  const res: any = await ml.searchQuestions({ seller_id: await sellerId(), status: 'UNANSWERED', api_version: 4, limit: 1 });
  setCount(Number(res?.total) || 0);
  return countCache!.n;
}

// Publica la respuesta en Mercado Libre. Una pregunta se responde UNA sola vez (ML no deja
// editar la respuesta), así que el texto se valida antes de mandarlo.
export async function answerQuestion(questionId: string, rawText: string) {
  const text = cleanAnswerText(rawText);
  const ml = await requireMlClient();
  await ml.answerQuestion(questionId, text);
  invalidateQuestionsCount();
  return { ok: true };
}
