# Ingenium Backend — Integración con Tienda Nube

API HTTP que orquesta la sincronización bidireccional entre Ingenium (POS multi-sucursal) y una tienda de **Tienda Nube**.

- **Stack**: Node.js 22 + Fastify + TypeScript + Prisma + PostgreSQL
- **Auth**: JWT (con login por PIN o password)
- **OAuth 2.0** con Tienda Nube + webhooks firmados (HMAC-SHA256)
- **Cola de sync** con reintentos exponenciales y resolución manual de conflictos
- **Storage** de imágenes centralizado (driver local para dev, R2 stub para prod)

---

## 1) Requisitos previos

- **Node.js 22+** (`node -v`)
- **Docker + Docker Compose** (para PostgreSQL en dev)
- **Cuenta de Partners de Tienda Nube** con una app creada:
  <https://partners.tiendanube.com/>
- **Una URL pública** para recibir webhooks y el OAuth callback. En desarrollo usá **ngrok** o **cloudflared**:
  ```bash
  npx ngrok http 3000
  ```
  Te va a dar algo como `https://abc123.ngrok-free.app` — esa es tu `PUBLIC_BASE_URL`.

---

## 2) Configurar la app en Tienda Nube

En el panel de Partners TN, dentro de tu app:

| Campo | Valor |
|---|---|
| **URL de redirección (OAuth)** | `https://<PUBLIC_BASE_URL>/api/integrations/tiendanube/callback` |
| **Scopes** | `read_products`, `write_products`, `read_orders`, `write_orders`, `read_customers`, `write_customers`, `read_shipping`, `read_content` |

Anotá el **Client ID** y el **Client Secret** — se cargan en `.env` (ver abajo).

Los webhooks se registran automáticamente cuando el usuario conecta la tienda, en `POST https://<PUBLIC_BASE_URL>/webhooks/tiendanube`. Firmados con el `Client Secret` (o con el `webhookSecret` por tienda, si lo configurás).

Eventos que escuchamos:
- `order/paid` → crea una *Tn Order Pending* para que el usuario le asigne sucursal
- `order/cancelled` → devuelve stock y genera un *Return* si ya estaba asignada
- `product/created` → crea un *Tn Product Pending* para aprobación + stock inicial
- `product/updated` → sync bidireccional con *last-write-wins*
- `product/deleted` → desactiva o rompe el mapping
- `customer/created` → crea/enlaza cliente local

---

## 3) Setup local paso a paso

```bash
cd backend

# 3.1 Instalar dependencias
npm install

# 3.2 Copiar env y completar
cp .env.example .env
# Editar .env con tus valores (ver sección 4)

# 3.3 Levantar PostgreSQL
docker compose up -d

# 3.4 Crear schema en la base (primera vez)
npx prisma migrate dev --name init

# 3.5 Generar el cliente de Prisma
npx prisma generate

# 3.6 (Opcional) abrir Prisma Studio para ver la base
npx prisma studio

# 3.7 Arrancar el backend en modo dev (tsx watch)
npm run dev
```

El servidor queda en `http://localhost:3000`.

Si vas a recibir webhooks TN en este dev, **arrancá ngrok** en paralelo (`npx ngrok http 3000`) y usá esa URL como `PUBLIC_BASE_URL` en `.env`.

---

## 4) Variables de entorno

Las críticas:

| Variable | Para qué sirve | Cómo generarla |
|---|---|---|
| `DATABASE_URL` | Conexión a Postgres | Ya viene apuntando al docker-compose local |
| `JWT_SECRET` | Firma de tokens de sesión | `openssl rand -hex 32` |
| `ENCRYPTION_KEY` | Encripta tokens TN en la base (AES-256-GCM) | `openssl rand -hex 32` — **son 64 caracteres hex exactos** |
| `PUBLIC_BASE_URL` | URL pública del backend (OAuth + webhooks) | Tu ngrok o tu dominio prod |
| `TN_CLIENT_ID` / `TN_CLIENT_SECRET` | Credenciales de tu app TN | Panel de Partners TN |
| `CORS_ORIGINS` | Orígenes permitidos desde el frontend | Ej: `http://localhost:5500,http://127.0.0.1:5500` |
| `STORAGE_DRIVER` | `local` o `r2` | En dev dejar `local` |

Las opcionales relevantes:

| Variable | Default | Notas |
|---|---|---|
| `PORT` | `3000` | |
| `JWT_EXPIRES_IN` | `12h` | |
| `SYNC_WORKER_INTERVAL_MS` | `5000` | Cada cuánto polea la cola de sync |
| `SYNC_MAX_RETRIES` | `5` | Backoff exponencial hasta 1h |
| `STORAGE_LOCAL_PATH` | `./storage/images` | Dónde caen los archivos en driver local |
| `STORAGE_PUBLIC_URL` | `http://localhost:3000/images` | Base pública para servirlas |

### Cambiar a producción (Railway / VPS)

1. Usar Postgres gestionado (Railway, Neon, Supabase) y poner `DATABASE_URL`.
2. Generar `JWT_SECRET` y `ENCRYPTION_KEY` **nuevos** (no reusar los de dev).
3. Cambiar `PUBLIC_BASE_URL` a tu dominio HTTPS real.
4. Cambiar `STORAGE_DRIVER=r2` y completar las `R2_*` (cuando esté implementado — el stub actual tira `NotYetImplemented`).
5. `CORS_ORIGINS` → tu dominio del frontend.

---

## 5) Seed / usuarios demo

El backend **no trae seed propio**. Para crear el primer admin, abrí una consola de Prisma:

```bash
npx prisma studio
```

Y cargá manualmente una fila en:

1. `Branch` → ej. `{ id: "lomas", name: "Lomas" }` y `{ id: "banfield", name: "Banfield" }`
2. `User` → `{ email: "admin@ingenium.local", passwordHash: <bcrypt de tu password>, branchId: "lomas", role: "admin", active: true }`

Para generar el hash rápido:
```bash
node -e "import('bcryptjs').then(b => b.hash('admin123', 10).then(h => console.log(h)))"
```

Después podés loguearte vía:
- `POST /auth/login` con `{ email, password }` o
- `POST /auth/login-pin` con `{ branchId, pin }` (si configuraste `pinHash`)

---

## 6) Conectar el frontend al backend

En la UI, andá a **Integraciones**:

1. Pegá la URL del backend (ej. `http://localhost:3000`) y **Guardar**.
   - Se guarda en `localStorage` con la clave `INGENIUM_API_BASE`.
2. Asegurate de estar logueado en el backend (el JWT se guarda en `INGENIUM_JWT`).
3. Click **Conectar** → te redirige a Tienda Nube para autorizar la app.
4. Al volver, vas a ver el badge en verde y el selector de **Modo de stock**:
   - `sum` — suma de todas las sucursales (default)
   - `lomas` — solo Lomas
   - `banfield` — solo Banfield

---

## 7) Flujo de uso típico

**Venta en POS (online)**
→ `POST /api/sales` → descuenta stock local + encola `push_stock` por variante + (si la venta vino de TN) `fulfill_tn_order`.

**Venta en POS (offline)**
→ se encola en IndexedDB (`sync_queue_local`).
→ Cuando vuelve internet, la cola hace `POST /api/sales/batch`.
→ Si alguna venta colisiona por stock, se marca con `conflict: true` y el usuario la resuelve desde **Conflictos**.

**Orden de Tienda Nube (webhook `order/paid`)**
→ entra a la UI en **Ventas Web**.
→ el usuario elige sucursal → `POST /api/tn-orders/:id/assign { branchId }`.
→ si faltan mappings de productos, la respuesta indica qué items están sin matchear.
→ si el stock no alcanza, ofrece confirmar con `allowNegative: true`.

**Producto creado en TN (webhook `product/created`)**
→ entra a **Productos TN**.
→ el usuario asigna costo + stock inicial por variante y por sucursal → `POST /api/tn-products-pending/:id/approve`.

**Producto modificado en TN o en Ingenium**
→ sync bidireccional. Gana el de `updatedAt` más reciente.

**Cancelación de orden TN ya asignada**
→ webhook `order/cancelled` → se crea automáticamente un `Return` que restituye stock.

---

## 8) Endpoints principales

### Auth
- `POST /auth/login` — `{ email, password }`
- `POST /auth/login-pin` — `{ branchId, pin }`
- `GET /auth/me`
- `GET /auth/branches`

### Catálogo
- `GET/POST /api/products`
- `GET/PATCH/DELETE /api/products/:id`
- `GET /api/products/by-barcode/:barcode`
- `GET/POST /api/products/:id/variants`
- `PATCH/DELETE /api/variants/:id`

### Stock
- `GET /api/stock?variantId=...&branchId=...`
- `POST /api/stock/set` — `{ variantId, branchId, qty, reason }`
- `POST /api/stock/adjust` — `{ variantId, branchId, delta, reason }`
- `POST /api/stock/transfer` — `{ variantId, fromBranchId, toBranchId, qty }`

### Ventas
- `POST /api/sales` — confirmar venta online
- `POST /api/sales/batch` — flush de cola offline (array de ventas)
- `POST /api/sales/:id/cancel`
- `GET /api/sales`

### Devoluciones
- `POST /api/returns`

### Caja
- `GET /api/cash/balance?branchId=...`
- `POST /api/cash/open` / `POST /api/cash/close`
- `POST /api/cash/move` — `{ type, amount, reason }`
- `POST /api/cash/expense`

### Clientes
- `GET/POST /api/customers`

### Integración TN
- `GET  /api/integrations/status`
- `GET  /api/integrations/tiendanube/authorize` → redirige a TN
- `GET  /api/integrations/tiendanube/callback` (OAuth)
- `POST /api/integrations/tiendanube/disconnect`
- `PATCH /api/integrations/tiendanube/settings` — `{ stockMode }`
- `GET  /api/tn-orders?status=pending`
- `POST /api/tn-orders/:id/assign` — `{ branchId, allowNegative? }`
- `GET  /api/tn-products-pending?status=pending`
- `POST /api/tn-products-pending/:id/approve` — `{ stockAssignments, costByVariant }`
- `POST /api/tn-products-pending/:id/reject`

### Sync
- `GET  /api/sync/log?limit=30`
- `GET  /api/sync/conflicts?status=open`
- `POST /api/sync/conflicts/:id/resolve` — `{ resolution: "accept"|"cancel"|"adjust" }`
- `POST /api/sync/conflicts/:id/dismiss`

### Webhooks TN (no auth — validados por HMAC)
- `POST /webhooks/tiendanube`

---

## 9) Troubleshooting

**"ENCRYPTION_KEY debe tener 64 caracteres hex"**
Generá una nueva con `openssl rand -hex 32`.

**Webhooks no llegan**
- ¿Está corriendo ngrok? ¿La `PUBLIC_BASE_URL` en `.env` coincide con la URL pública actual?
- Mirar `GET /api/sync/log` — los webhooks rechazados por HMAC inválido quedan registrados.

**OAuth callback redirige a error**
- Verificá que la URL de redirección en el panel de Partners TN coincida **exactamente** con `${PUBLIC_BASE_URL}/api/integrations/tiendanube/callback`.
- Mirar los logs del backend — TN devuelve el motivo en la query `?error=...`.

**"STOCK_INSUFFICIENT" al asignar una orden TN**
Esperado. O el usuario confirma con `allowNegative: true` desde la UI, o transfiere stock entre sucursales primero.

**Cola de sync trabada**
- `GET /api/sync/log` muestra los últimos jobs.
- Los que fallaron más de `SYNC_MAX_RETRIES` quedan con estado `error` — revisá el mensaje y o bien corregís el dato local, o hacés resolve manual.

**Productos con variantes no espejean bien**
Cada variante TN se mapea 1-a-1 con una variante Ingenium (`VariantTnMapping`). Si un producto existente en Ingenium no tiene variantes, el backend crea una variante `default` automáticamente al guardarlo.

---

## 10) Estructura del proyecto

```
backend/
├── prisma/
│   └── schema.prisma          # Modelo completo (24+8 tablas)
├── src/
│   ├── auth/                  # JWT + login PIN/password
│   ├── services/              # Lógica de negocio (products, sales, stock, ...)
│   ├── tiendanube/            # OAuth, client API, webhooks, mappers, sync handlers
│   ├── sync/                  # Cola, worker, conflictos
│   ├── storage/               # Abstracción de imágenes (local | r2)
│   ├── routes/                # Endpoints REST (Fastify + Zod)
│   ├── utils/                 # crypto, audit, errors
│   ├── config.ts              # env validada con Zod
│   ├── db.ts                  # Prisma singleton
│   └── server.ts              # Arranque Fastify
├── docker-compose.yml         # Postgres 16
├── .env.example
└── package.json
```

---

## 11) Licencia

Propietario. Prohibida su redistribución sin autorización.
