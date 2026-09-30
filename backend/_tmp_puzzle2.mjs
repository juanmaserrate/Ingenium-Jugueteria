import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_PUBLIC_URL } } });
// Productos por ambos códigos y por nombre
const prods = await prisma.product.findMany({
  where: { OR: [{ code: '092626510322' }, { code: '092626562284' }, { name: { contains: 'noche estrellada', mode: 'insensitive' } }] },
  include: { tnMapping: true, variants: { include: { tnMapping: true, stocks: true } } },
});
console.log('=== productos "noche estrellada" / por código ===');
for (const p of prods) {
  console.log(`PROD ${p.id} | code=${p.code} | "${p.name}" | active=${p.active} | TNprod=${p.tnMapping?.tnProductId||'no'}`);
  for (const v of p.variants) console.log(`   var ${v.id} code=${v.code} barcode=${v.barcode} tnVar=${v.tnMapping?.tnVariantId||'-'} stock=${v.stocks.map(s=>`${s.branchId}:${s.qty}`).join(' ')}`);
}
// ¿algún producto/variante local apunta al tnVariant o barcode nuevo?
const byBar = await prisma.variant.findMany({ where: { OR:[{barcode:'092626562284'},{code:'092626562284'},{barcode:'092626510322'},{code:'092626510322'}] }, include:{ product:true, tnMapping:true } });
console.log('\n=== variantes con esos barcodes/códigos ===');
for (const v of byBar) console.log(`var ${v.id} prod="${v.product?.name}" (${v.product?.code}) barcode=${v.barcode} code=${v.code} tnVar=${v.tnMapping?.tnVariantId||'-'}`);
await prisma.$disconnect();
