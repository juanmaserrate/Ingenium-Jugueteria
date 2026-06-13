import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { env } from '../config.js';
import { prisma } from '../db.js';
import { getPurchaseDocumentBuffer } from '../storage/documents.js';
import { AppError } from '../utils/errors.js';

// Shape forzado de la salida de Claude (tool use).
const lineSchema = z.object({
  nombre: z.string(),
  costoUnitario: z.number().nullable().optional(),
  cantidad: z.number().nullable().optional(),
  barcode: z.string().nullable().optional(),
  confianza: z.enum(['alta', 'media', 'baja']).optional(),
});
const extractSchema = z.object({
  invoiceType: z.string().nullable().optional(),
  invoiceNumber: z.string().nullable().optional(),
  supplierName: z.string().nullable().optional(),
  lines: z.array(lineSchema),
});

const TOOL = {
  name: 'extract_invoice',
  description: 'Devuelve las líneas de productos extraídas de una factura de proveedor.',
  input_schema: {
    type: 'object' as const,
    properties: {
      invoiceType: { type: ['string', 'null'], enum: ['A', 'X', 'desconocido', null] },
      invoiceNumber: { type: ['string', 'null'] },
      supplierName: { type: ['string', 'null'] },
      lines: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            nombre: { type: 'string' },
            costoUnitario: { type: ['number', 'null'] },
            cantidad: { type: ['number', 'null'] },
            barcode: { type: ['string', 'null'] },
            confianza: { type: 'string', enum: ['alta', 'media', 'baja'] },
          },
          required: ['nombre'],
        },
      },
    },
    required: ['lines'],
  },
};

const SYSTEM = `Sos un asistente que extrae líneas de facturas de proveedores de una juguetería argentina.
Devolvé SIEMPRE el resultado vía la herramienta extract_invoice.
Reglas:
- costoUnitario: el costo SIN IVA por unidad si está discriminado; si no, el que figure por unidad.
- cantidad: entero (unidades compradas de esa línea).
- barcode: solo si hay un EAN/UPC visible (12-13 dígitos); si no, null. NUNCA inventes códigos.
- Si una línea es ilegible, incluila igual con confianza "baja" y los campos que puedas.
- NO inventes precios ni nombres. Ignorá totales, subtotales, IVA y líneas que no sean productos.`;

export type ScanResult = {
  scanStatus: 'ok' | 'partial' | 'failed';
  invoiceType?: string | null;
  invoiceNumber?: string | null;
  supplierName?: string | null;
  lines: Array<{ nombre: string; costoUnitario: number | null; cantidad: number | null; barcode: string | null; confianza: string }>;
};

/**
 * Escanea un documento (PDF o imagen) de una compra con Claude y devuelve las
 * líneas extraídas. Robusto: sin API key → 503 controlado; cualquier error de la
 * API → scanStatus 'failed' con lines vacío (nunca 500 pelado). No persiste nada.
 */
export async function scanInvoice(purchaseId: string, documentId: string): Promise<ScanResult> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new AppError(503, 'Escaneo IA no disponible: falta ANTHROPIC_API_KEY', 'SCAN_UNAVAILABLE');
  }
  const doc = await prisma.purchaseDocument.findUnique({ where: { id: documentId } });
  if (!doc || doc.purchaseId !== purchaseId) {
    throw new AppError(404, 'Documento no encontrado', 'NOT_FOUND');
  }

  let buf: Buffer;
  try {
    buf = await getPurchaseDocumentBuffer(doc.storageKey);
  } catch {
    throw new AppError(404, 'No se pudo leer el documento del storage', 'DOC_READ_FAILED');
  }
  const b64 = buf.toString('base64');
  const isPdf = doc.contentType === 'application/pdf' || doc.filename.toLowerCase().endsWith('.pdf');

  const contentBlock = isPdf
    ? { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: b64 } }
    : { type: 'image' as const, source: { type: 'base64' as const, media_type: (doc.contentType || 'image/jpeg') as any, data: b64 } };

  try {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 60_000 });
    const resp = await client.messages.create({
      model: env.ANTHROPIC_MODEL,
      max_tokens: 4096,
      system: SYSTEM,
      tools: [TOOL],
      tool_choice: { type: 'tool', name: 'extract_invoice' },
      messages: [{
        role: 'user',
        content: [
          contentBlock as any,
          { type: 'text', text: 'Extraé todas las líneas de productos de esta factura.' },
        ],
      }],
    });

    const toolUse = resp.content.find((c: any) => c.type === 'tool_use') as any;
    if (!toolUse) return { scanStatus: 'failed', lines: [] };

    const parsed = extractSchema.safeParse(toolUse.input);
    if (!parsed.success) return { scanStatus: 'failed', lines: [] };

    const lines = parsed.data.lines.map((l) => ({
      nombre: l.nombre,
      costoUnitario: l.costoUnitario ?? null,
      cantidad: l.cantidad ?? null,
      barcode: l.barcode ?? null,
      confianza: l.confianza ?? 'media',
    }));
    const anyLow = lines.some((l) => l.confianza === 'baja' || l.costoUnitario == null || l.cantidad == null);
    const scanStatus = lines.length === 0 ? 'failed' : (anyLow ? 'partial' : 'ok');

    return {
      scanStatus,
      invoiceType: parsed.data.invoiceType ?? null,
      invoiceNumber: parsed.data.invoiceNumber ?? null,
      supplierName: parsed.data.supplierName ?? null,
      lines,
    };
  } catch (err) {
    // Falla de la API (red, rate limit, modelo): devolvemos failed para que el
    // operador cargue manual. No propagamos 500.
    return { scanStatus: 'failed', lines: [] };
  }
}
