# Plan — Integración nativa de Mercado Libre en Ingenium

> Objetivo: vender en Mercado Libre (ML) con **stock único** compartido con POS y Tienda Nube (TN),
> órdenes de ML que se registran como ventas en el sistema, y stock que se descuenta automáticamente
> en ML cuando vendés por cualquier canal. Todo nativo, reusando el molde de TN.

Estado base verificado por mapeo del código (septiembre–noviembre 2026). TN vive aislado en
`backend/src/tiendanube/` + `backend/src/sync/`; ML se construye como espejo en `backend/src/mercadolibre/`
reusando la misma cola/worker. **El 70% de la infraestructura ya existe.**

---

## 0. Estrategia

1. **Clonar el patrón de TN, no inventar.** Mismo modelo `Integration`, misma cola `SyncQueue`, mismo worker, mismos "pending orders".
2. **El backend es la única fuente de verdad del stock.** Cada venta (POS/TN/ML) descuenta el stock físico y **empuja la cantidad absoluta** a TN y a ML. Nunca se delega el stock a un canal.
3. **Por fases, de menor a mayor riesgo.** Primero lo que más valor da con menos peligro (no sobrevender), al final lo más delicado (publicar).
4. **Nada toca el dinero sin congelarse.** El costo de la comisión de Mercado Pago se guarda por venta (`cost_meta`) igual que ya hacemos con promos/TN.

**Diferencias clave de ML vs TN (lo que hay que agregar sí o sí):**

| Tema | TN (hoy) | ML (nuevo) |
|---|---|---|
| Token | Largo, no expira | **Expira ~3–6 h, refresh token de UN SOLO USO, expira a los 6 meses** |
| Webhook auth | HMAC con secret | **Sin HMAC** — notificación "fina", hay que ir a buscar el recurso con tu token |
| Stock | `PUT /products/:id/variants` | `PUT /items` (o `user-products` si la cuenta es multiorigen) |
| Pagos | Varios gateways | **Mercado Pago obligatorio** → la comisión real viene en la orden (`sale_fee`) |
| Publicación | Flexible | **Categoría + atributos obligatorios**, catálogo estricto (riesgo de reclamo/suspensión) |

---

## 1. Mapa de entrada — "cómo entro a cada cosa"

### Archivos NUEVOS (espejo de `tiendanube/`)
| Nuevo | Clona de | Qué hace |
|---|---|---|
| `backend/src/mercadolibre/oauth.ts` | `tiendanube/oauth.ts` | authorize URL, exchange code, **refresh token**, saveIntegration |
| `backend/src/mercadolibre/client.ts` | `tiendanube/client.ts:6` | `MlClient` axios, header `Authorization: Bearer`, **refresh on 401**, retry 429 (`Retry-After`) |
| `backend/src/mercadolibre/webhooks.ts` | `tiendanube/webhooks.ts` | ingest de órdenes/items, anti-eco, dispatch |
| `backend/src/mercadolibre/sync.ts` | `tiendanube/sync.ts` | handlers `ml_push_stock`, `ml_push_item`, etc. |
| `backend/src/mercadolibre/link.ts` | `tiendanube/link.ts:243` (`relinkProduct`) | enlazar variante interna ↔ `item_id`/`variation_id` |
| `backend/src/mercadolibre/mappers.ts` | `tiendanube/mappers.ts` | item ML ↔ producto interno |
| `backend/src/routes/mlWebhooks.ts` | `routes/webhooks.ts` | `POST /webhooks/ml` (público, sin `/api`) |
| `backend/src/services/paymentCost.ts` → `buildCostMetaForMl` | junto a `buildCostMetaForTn` (`paymentCost.ts:86-107`) | congela el `sale_fee` de MP como costo del pago |
| `src/modules/mercadolibre.js` (+ espejo en `backend/public/`) | `src/modules/integraciones.js` | pantalla conectar/estado/log |
| `src/modules/ventas-ml.js` (opcional) | `src/modules/ventas-web.js` | órdenes ML pendientes de asignar a sucursal |

### Archivos que se MODIFICAN (puntos exactos)
| Archivo:línea | Cambio |
|---|---|
| `backend/prisma/schema.prisma:662-675` (`Integration`) | agregar `refreshTokenEnc`, `tokenExpiresAt` (ML refresca; TN no) |
| `backend/prisma/schema.prisma` | nuevos modelos `MlOrderPending` (espejo `TnOrderPending:706`), `ProductMeliMapping`/`VariantMeliMapping` (espejo `:677`/`:690`). **`Product.publishedMeli` ya existe (`:147`)** |
| `backend/src/scripts/seed.ts` | **DDL idempotente** para las tablas/columnas nuevas (ver §4 — gotcha Railway) |
| `backend/src/config.ts:17-20` | agregar `ML_CLIENT_ID`, `ML_CLIENT_SECRET`, `ML_AUTH_BASE`, redirect URI (patrón `z.string().default('')`) |
| `backend/src/server.ts:171,178` | `register(mlIntegrationsRoutes, {prefix:'/api'})` y `register(mlWebhooksRoutes)` (sin prefix) |
| `backend/src/sync/worker.ts:68` | **generalizar el guard** `Integration.active` — hoy está hardcodeado a `provider:'tiendanube'`; los jobs de ML no deben saltearse si TN está apagado |
| `backend/src/services/sales.ts:59` + `backend/src/routes/sales.ts:37` | ampliar enum `source` de `'pos'|'tn'` a incluir `'ml'` (el `schema.prisma:263` ya acepta String) |
| `backend/src/services/stock.ts:11` (`computeTnStockForVariant`) | análogo `computeMlStockForVariant` (hoy lee `Integration.stockMode` de TN) |
| `src/modules/reports.js:267` (+`:131,:499,:394`) | mapear `source==='ml' → 'Mercado Libre'` y opción de filtro |
| `src/modules/ventas.js:30,147,232-236,269-273` | filtro + badge de canal "ML" |
| `app.html:99-102` (+ espejo) | `registerRoute('/mercadolibre', …)` |
| `src/core/router.js:7-11` | `/mercadolibre` → `ADMIN_ONLY` |
| `src/components/sidebar.js:20-54` | sección "Mercado Libre" + items (convención `admin:true`) |

### Se REUSAN sin tocar (o casi)
- `backend/src/sync/queue.ts` (cola, dedupe, backoff, reaper) — se agregan operaciones ML, la mecánica es la misma.
- `backend/src/utils/crypto.ts` (`encrypt`/`decrypt` AES-256-GCM, `ENCRYPTION_KEY`).
- `backend/src/services/sales.ts` `confirmSale` — **ya respeta un `cost_meta` provisto tal cual** (`sales.ts:130-136`), así que la venta de ML se arma pasándole el costo de MP congelado.
- `SyncConflict` + `src/modules/conflictos.js` — sistema de conflictos ya es agnóstico del proveedor.
- Scripts de mirror a `backend/public/` (pre-commit hook).

---

## 2. Fases de implementación

### Fase 0 — Fundaciones (conexión segura)
Objetivo: poder conectar la cuenta de ML y mantener el token vivo, sin tocar stock ni ventas todavía.
1. Registrar la app en el **DevCenter de ML** → `Client ID` + `Secret` + redirect URI (`…/api/integrations/ml/callback`). *(único input externo — ver §6)*
2. Agregar env (`config.ts`) + migración de schema (`Integration` con refresh fields + DDL en `seed.ts`).
3. `mercadolibre/oauth.ts`: authorize → callback → exchange → `saveIntegration(provider:'mercadolibre')` con token y **refresh token** cifrados.
4. `mercadolibre/client.ts`: cada request chequea expiración; **refresh proactivo** antes de vencer; on 401 → refresh-once-and-retry; **lock de single-flight** para no refrescar en paralelo (ver bug #1).
5. UI `mercadolibre.js`: botón Conectar/Desconectar + estado.
**Entregable:** cuenta conectada, token que se renueva solo. Verificable con un `GET /users/me` a la API de ML.

### Fase 1 — Stock-out seguro (nunca sobrevender) ← **mayor beneficio, menor riesgo**
1. `ProductMeliMapping`/`VariantMeliMapping` + enlace manual (`link.ts`): mapear variante interna ↔ `item_id`.
2. Handler `ml_push_stock` (espejo `sync.ts:148-163`): computa qty absoluta y hace `PUT /items` (`available_quantity`). Detectar cuenta multiorigen → usar `user-products` si corresponde (bug #9).
3. Enganchar el enqueue: en `sales.ts:282-285` (post-commit) y en `stock.ts`, además de `push_stock` (TN) encolar `ml_push_stock` para variantes mapeadas a ML.
4. Job de **reconciliación** periódico: comparar stock local vs ML y corregir (como `reconcileTnOrders`).
**Entregable:** vendés en el local o en TN y ML baja el stock solo. Imposible sobrevender.

### Fase 2 — Órdenes de ML → ventas
1. `MlOrderPending` (espejo `TnOrderPending`) + `mlWebhooks.ts` que recibe la notificación `orders_v2`, va a buscar `GET /orders/{id}` y hace `ingestPaidMlOrder` (espejo `webhooks.ts:35-94`).
2. `buildCostMetaForMl` en `paymentCost.ts`: toma `sale_fee`/`marketplace_fee` real de la orden → `costAmount` exacto (no estimado).
3. Ruta `/ml-orders/:id/assign` (clon de `integrations.ts:507-603`) → `confirmSale({ source:'ml', payments:[{ methodId:'mercadolibre', costMeta: mlCostMeta }], … })`. Modo **manual** (asignar a sucursal) + opción automático.
4. Cancelaciones/reversas: handler que, si la orden ya era venta, dispara `processReturn` y re-empuja stock a todos los canales (espejo `handleOrderCancelled`).
5. Reportes: `source==='ml' → 'Mercado Libre'` (reports.js) → aparece en "Por canal" y en el reporte de ganancia con su costo MP.
**Entregable:** las ventas de ML entran al sistema, descuentan stock y miden ganancia real.

### Fase 3 — Publicación desde el sistema (lo más delicado)
1. Buscar categoría/catálogo (`GET /categories`, `GET /products/search`), crear/editar publicaciones (`POST /items`) desde el inventario.
2. Publicación tradicional primero (sin catálogo); catálogo con `catalog_listing:true` solo cuando matchea la ficha (riesgo de reclamo si no coincide).
3. Manejo de variaciones (un `POST` por variación), fotos, atributos obligatorios.
**Entregable:** alta/edición de publicaciones ML desde Ingenium. *(Se puede diferir; muchos vendedores publican a mano y solo quieren Fases 1–2.)*

---

## 3. Previsión de bugs / errores → soluciones (el corazón del plan)

### A. Autenticación y tokens
| # | Bug/Error | Causa | Prevención / Solución |
|---|---|---|---|
| 1 | **Conexión se cae sola** | Refresh token de ML es de **un solo uso**: dos refresh concurrentes se invalidan entre sí | **Single-flight lock** sobre el refresh (una sola renovación a la vez; a nivel proceso + guard en DB con `tokenExpiresAt`). Refrescar **proactivo** (antes de vencer, margen ~10 min). Guardar el **nuevo** refresh token atómicamente. El worker es mono-hilo → ayuda, pero las requests web también refrescan: centralizar en `client.ts`. |
| 2 | 401 en medio de una operación | Token venció entre requests | En `client.ts`: on 401 → refresh **una vez** → reintentar la request original. Si el refresh falla → marcar `Integration.active=false` + avisar en UI "reconectar". |
| 3 | Refresh token muerto a los 6 meses | Expira sin uso / se desincroniza | Detectar fallo de refresh → estado "desconectado, reautorizar" en `mercadolibre.js`. Nunca borrar el token viejo hasta confirmar el nuevo. |
| 4 | 403 inesperado | Scope insuficiente, app bloqueada, IP no permitida, token de otro usuario | Pedir scope `offline_access` + read/write al autorizar. Loguear el body del 403 (trae la causa). No reintentar un 403 (no se arregla reintentando). |

### B. Webhooks / notificaciones
| # | Bug/Error | Causa | Prevención / Solución |
|---|---|---|---|
| 5 | **Órdenes falsas / inyección** | La notificación de ML **no viene firmada** (sin HMAC) | **Nunca** confiar en el body. Siempre `GET /orders/{id}` con tu token y **verificar que `order.seller.id` == tu seller id**. Opcional: allowlist de IPs de ML. |
| 6 | Timeout → ML reintenta y duplica | El endpoint tarda (procesa inline) | Responder **200 en <500 ms**: solo encolar (crear `MlOrderPending` o un job) y procesar async en el worker. ML reintenta 12 h si no hay 200. |
| 7 | Notificación duplicada / fuera de orden | ML reenvía; varias por la misma orden | **Idempotencia**: `MlOrderPending.mlOrderId @unique` + dedup por `notification._id`. Capturar `P2002` como "ya recibida" (igual que `webhooks.ts:76`). Siempre releer la orden (no confiar en el orden de llegada). |
| 8 | Notificación perdida (caída/redeploy) | Webhook no llegó | Job de **reconciliación** por polling (`GET /orders/search?seller=…&order.status=paid`) tipo `reconcileTnOrders` (`integrations.ts:46-70`). `myfeeds` para recuperar notificaciones perdidas. |

### C. Stock / sobreventa (lo más caro si falla)
| # | Bug/Error | Causa | Prevención / Solución |
|---|---|---|---|
| 9 | **`PUT /items` devuelve 200 pero no actualiza** | Cuenta **multiorigen** (warehouse_management): `available_quantity` en `/items` no aplica | Detectar tipo de cuenta; si es multiorigen usar `PUT /user-products/{id}/stock/...` con header específico. Verificar leyendo el stock después del push. |
| 10 | **Sobreventa entre 3 canales** | Vendés el último en el local y ML lo sigue mostrando hasta el próximo push | Push **inmediato** post-venta (ya es el patrón, `sales.ts:282`). Empujar **cantidad absoluta** (set, no decremento) → idempotente. Job de reconciliación de respaldo. Considerar un pequeño colchón si la latencia preocupa. |
| 11 | 409 Conflict al actualizar stock | Modificaciones concurrentes / SKU ya asociado a otro user_product | Backoff con reintento (ya está en `markFailed`, `queue.ts:113`). Asegurar unicidad de SKU/GTIN. Actualizar el user_product existente, no crear duplicados. |
| 12 | **Eco: el push a ML dispara un webhook que re-procesamos** | ML notifica el cambio de item que nosotros hicimos | **Anti-eco** con ventana de tiempo (`lastPushAt` + `ECHO_WINDOW_MS`, igual que `webhooks.ts:183-197`): si el cambio es < 2 min de nuestro push, se ignora. |
| 13 | `stock-locations not found` | User product sin ubicaciones inicializadas | Crear las ubicaciones antes del primer push (manejar el error e inicializar). |

### D. Órdenes → ventas / dinero
| # | Bug/Error | Causa | Prevención / Solución |
|---|---|---|---|
| 14 | Venta ML duplicada en el sistema | Reintentos / doble asignación | `offlineId` = `ml_{orderId}` único en `Sale` (idempotencia de `confirmSale`, `sales.ts:106-109,266`). Claim atómico `updateMany(status pending→assigning)` como `integrations.ts:556`. |
| 15 | **Orden cancelada después de cobrada** (reversa de pago) | ML puede pasar `paid → cancelled` | Handler de cancelación: si ya era venta → `processReturn` (restock) + re-push a todos los canales. (MX tiene caso especial de reembolso que no cancela → tratar por país.) |
| 16 | Costo/ganancia mal calculada | Estimar la comisión en vez de usar la real | Usar el **`sale_fee`/`marketplace_fee` real** de la orden: `costAmount = sale_fee`, `costPct = sale_fee/amount*100` para mantener el shape de `cost_meta` que consume `reports.js:260`. |
| 17 | Total no cuadra (envío) | El total de la orden incluye envío | Tomar el **subtotal de productos**, no el total de la orden (igual que TN, `integrations.ts:541-550`). El envío no es venta de mercadería. |
| 18 | Ítem de ML sin producto local | Publicación no mapeada | Devolver `unmapped_items` y mostrar en UI para mapear (patrón `integrations.ts:521-524` / `ventas-web.js`). No crear la venta hasta mapear. |

### E. Plataforma / infraestructura
| # | Bug/Error | Causa | Prevención / Solución |
|---|---|---|---|
| 19 | **Columnas/tablas nuevas no se crean en Railway** | `prisma db push` no crea confiablemente en prod (gotcha ya sufrido 2 veces) | **DDL idempotente en `seed.ts`**: `ALTER TABLE ADD COLUMN IF NOT EXISTS` + `CREATE TABLE/INDEX IF NOT EXISTS` con los nombres que espera Prisma. Lecturas tolerantes (try/catch → fallback) hasta que la tabla exista. |
| 20 | Rate limit 429 | Muchas requests (ráfaga de pushes) | Reusar el patrón de `TnClient` (`client.ts:25-40`): honrar `Retry-After`, backoff exponencial, worker mono-hilo como throttle natural. (~1500 req/min por seller, a verificar.) |
| 21 | Cambio solo en `src/` y no en `backend/public/` | Doble árbol de frontend | Correr el mirror script (pre-commit hook ya lo hace); checklist: toda edición de front va en **ambos** árboles. |
| 22 | Worker saltea jobs de ML si TN está apagado | `worker.ts:68` guard hardcodeado a `provider:'tiendanube'` | **Generalizar el guard** por proveedor: los `ml_*` corren según `Integration(provider='mercadolibre').active`, independiente de TN. |
| 23 | Deploy no se auto-dispara | Flakiness de Railway (ya visto) | Commit vacío para re-disparar; verificar con marcador servido + cache-buster. |
| 24 | Jobs "running" huérfanos tras redeploy | Crash/redeploy a mitad de job | Ya resuelto: `reapStuckJobs` + reaper por lease (`SYNC_JOB_LEASE_MS=5min`) + full-reap al boot (`worker.ts recoverOnBoot`). Aplica igual a ops ML. |

### F. Publicación / catálogo (Fase 3)
| # | Bug/Error | Causa | Prevención / Solución |
|---|---|---|---|
| 25 | **Reclamo / suspensión de cuenta** | Publicar algo que no coincide con la ficha del catálogo | Vendedor confirma el match; empezar con publicaciones tradicionales; catálogo solo con match validado. |
| 26 | Rechazo por categoría/atributos | Faltan atributos obligatorios | Usar el predictor de categoría + traer atributos requeridos antes de publicar; validar en dry-run. |
| 27 | Variaciones mal publicadas | Catálogo requiere un POST por variación | Iterar variaciones enviando `variation_id` (patrón documentado). |

---

## 4. Procedimientos que voy a ejecutar (paso a paso)

**Por cada cambio de código (el ciclo ya probado en este proyecto):**
1. Editar en `src/` → `node scripts/mirror-frontend.mjs` (espeja a `backend/public/`).
2. Backend: `npx tsc --noEmit` para typecheck; front: `node --check`.
3. **Schema nuevo → DDL idempotente en `backend/src/scripts/seed.ts`** (no confiar en `prisma db push`). `runSeed` corre en cada boot.
4. Commit + push a `main` → Railway auto-deploy. Si no dispara: commit vacío.
5. Verificar en prod: marcador servido con cache-buster `?v=timestamp`; y pruebas funcionales por la API con la sesión de admin.

**Secuencia concreta Fase 0–1 (lo que haría primero):**
1. **DevCenter** (vía tu Chrome, con tu cuenta de ML ya abierta): crear app, setear redirect URI, copiar `Client ID`/`Secret`. *(Esto define `ML_CLIENT_ID`/`ML_CLIENT_SECRET` en Railway.)*
2. Schema: `Integration` + `refreshTokenEnc`/`tokenExpiresAt`, `ProductMeliMapping`/`VariantMeliMapping` → DDL en `seed.ts`.
3. `config.ts` + `oauth.ts` + `client.ts` (con refresh single-flight) + ruta connect/callback + UI.
4. Deploy → conectar la cuenta → verificar `GET /users/me`.
5. Enlazar 1–2 productos (mapping) → handler `ml_push_stock` → enganchar enqueue → **probar: vender en POS y ver bajar el stock en la publicación de ML.**

**Verificación por fase:** Fase 0 = token vivo; Fase 1 = stock sincroniza en ambos sentidos sin sobreventa; Fase 2 = una orden real de ML entra como venta con su costo MP; Fase 3 = una publicación creada desde el sistema.

---

## 5. Riesgos residuales y lo único que depende de vos

- **Lo único que no puedo generar yo:** el `Client ID`/`Secret` de la app de ML (se crean en TU cuenta del DevCenter). Con tu Chrome abierto en ML, cuando digas, hago la registración de la app con vos y copiamos las credenciales a Railway.
- **A verificar en implementación:** si tu cuenta de ML es **multiorigen** (cambia el endpoint de stock, bug #9), y el valor real del rate limit.
- **Decisión de alcance:** Fases 1–2 dan el 90% del valor (no sobrevender + ventas con costo real). La Fase 3 (publicar desde el sistema) es opcional si preferís seguir publicando a mano.
- **Costo de ML:** comisiones más altas que TN + Mercado Envíos; todo se refleja como costo real en el reporte de ganancia (ya tenemos el módulo).

---

## Referencias API ML (verificar contra docs oficiales al construir)
- Auth/OAuth y tokens, 403: developers.mercadolibre.com.ar/en_us/authentication-and-authorization
- Notificaciones (orders_v2): developers.mercadolibre.com.ar/en_us/products-receive-notifications
- Órdenes (estados paid/cancelled, date_closed): developers.mercadolibre.com.ar/en_us/manage-sales
- Stock (items / user-products multiorigen): developers.mercadolibre.com.ar/en_us/multi-origin-stock-management-user-products
- Publicación en catálogo: developers.mercadolibre.com.ar/en_us/catalog-listing
- Rate limit 429: developers.mercadolivre.com.br/en_us/rate-limit-429-error
