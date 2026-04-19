import type { FastifyInstance } from 'fastify';
import { saveProductImage, deleteProductImage } from '../storage/images.js';

export async function imagesRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.post('/products/:productId/images', async (req) => {
    const { productId } = req.params as { productId: string };
    const file = await (req as any).file();
    if (!file) throw new Error('No file uploaded');
    const buf = await file.toBuffer();
    return saveProductImage(productId, buf, file.mimetype ?? 'image/jpeg', file.filename);
  });

  app.delete('/images/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await deleteProductImage(id);
    return reply.status(204).send();
  });
}
