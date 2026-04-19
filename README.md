# Ingenium — Sistema de Ventas

Sistema integral de gestión para jugueterías multi-sucursal (Lomas y Banfield).
Prototipo local completo — 16 módulos, POS, caja, devoluciones, finanzas, CRM, empleados, inventario, reportes y dashboard.

**Fase 2 — Integración con Tienda Nube**: sync bidireccional de productos, stock y órdenes + modo offline con cola local.
Setup y documentación del backend en [`backend/README.md`](backend/README.md).

---

## Fase 1 — Prototipo local (estado actual: COMPLETO)

**Abrí `index.html` en el navegador.** No requiere instalar nada.

> ⚠️ Los módulos usan **ES modules** (`<script type="module">`). Si el navegador bloquea por CORS al abrir con `file://`, levantá un servidor local:
>
> ```bash
> python -m http.server 8080
> # luego abrir http://localhost:8080
> ```

### Credenciales demo

| Sucursal | Usuario | Rol | PIN |
|---|---|---|---|
| Lomas | Admin Ingenium | admin | `1234` |
| Lomas | Lucas Rodriguez | manager | `1111` |
| Lomas | Sofia Martinez | seller | `1111` |
| Banfield | Mateo Gomez | manager | `2222` |
| Banfield | Camila Lopez | seller | `2222` |

En primera carga se siembran datos de prueba (20 productos, 3 clientes, 4 empleados, stock en ambas sucursales, apertura de caja). Desde el login o desde Configuración → Zona peligrosa podés "Resetear demo" para empezar de cero.

---

## Módulos (sidebar)

### Operación
- **Dashboard** — KPIs de ventas del día/mes, saldo de caja, valor de inventario, stock crítico, cheques, cumpleaños. 4 gráficos (Chart.js): ventas 30 días, medios de pago, top productos del mes, ventas por categoría. Feed de actividad reciente.
- **POS / Ventas** — Multi-pestaña con persistencia de borradores. Buscador con Enter-to-add, catálogo modal, edición inline del precio (doble click), descuentos por ítem y globales, recargos, cliente/vendedor, pagos mixtos con validación, "Pagar todo en efvo" rápido.
- **Devoluciones** — Los 5 casos operativos:
  1. Devolución total con reintegro
  2. Devolución total con vale
  3. Cambio exacto (sin diferencia)
  4. Cambio con diferencia a favor cliente → efvo o vale
  5. Cambio con diferencia a favor del negocio → cliente paga
- **Caja** — Apertura/cierre diario con arqueo, movimientos manuales (ajustes), registro de gastos por categoría y método, export XLSX.

### Catálogo
- **Inventario** — CRUD completo de productos, categorías, marcas, proveedores. Stock multi-sucursal con ajustes auditados. Transferencias entre sucursales con número correlativo y remito. Import/export XLSX.

### Comercial
- **CRM** — Directorio de clientes con búsqueda, filtro "cumpleaños del mes", ficha con stats (compras, gastado, vales), historial de compras y vales. Export XLSX.
- **Saldo** — Facturado, devuelto, saldo neto, ticket promedio. Filtros por período (día/mes/año/custom), medio, categoría, marca, proveedor, vendedor. Desglose por medio de pago con barras. Export multi-hoja.
- **Ganancias** — P&L mensual con comparación vs mes anterior: ventas brutas, IVA, ventas netas, COGS (desde cost_snapshot), ganancia bruta, gastos, cheques, devoluciones, ganancia neta. Breakdown por categoría. Snapshot guardable.
- **Contribución Marginal** — Top 20/50/100/500 por producto/categoría/marca/proveedor. Ventas, costo, CM $, CM %, share.
- **Cheques** — Tabs all/pending/overdue/soon (7d)/paid/bounced. KPIs agregados. CRUD con cambio de estado. Notificaciones push automáticas para vencimientos próximos.

### Gente
- **Empleados** — CRUD + tab de horas del mes: check-in/check-out/nota por día, cálculo automático de horas y pago estimado.
- **Tareas** — Kanban drag & drop (Pendiente / En curso / Hecho). Prioridad, vencimiento con highlight, asignado.

### Meta
- **Calendario** — Grilla mensual con eventos agregados: cumpleaños de clientes, vencimiento de cheques, feriados argentinos fijos, eventos editables propios.
- **Reportes** — 12 exports XLSX: ventas, devoluciones, caja, gastos, P&L, inventario, transferencias, stock por categoría, cheques, empleados+horas, auditoría, clientes.
- **Historial** — Log de auditoría completo con filtros por acción, entidad, usuario, rango de fechas, búsqueda libre. Export XLSX.
- **Configuración** — 6 tabs: Empresa, Sucursales, Usuarios (con PIN), Métodos de pago (con recargo % y flag "afecta caja"), Sistema (validez de vales), Zona peligrosa (reset demo).

---

## Estructura del código

```
Ingenium/
├── index.html                 Login (sucursal + usuario + PIN)
├── app.html                   Shell (sidebar + topbar + router)
├── assets/css/custom.css      Estilos extendidos (toasts, modal, tabla, botones)
└── src/
    ├── config/theme.js        Tailwind config (colores Ingenium)
    ├── core/
    │   ├── schema.js          Stores IndexedDB (fuente de verdad del modelo)
    │   ├── db.js              Wrapper IndexedDB (get/put/tx/index)
    │   ├── auth.js            Sesión + PIN + sucursal activa
    │   ├── router.js          Hash routing con lazy import
    │   ├── format.js          Moneda AR, fechas, IVA (21%), horas
    │   ├── events.js          Event bus + BroadcastChannel (multi-tab sync)
    │   ├── audit.js            Registro de auditoría
    │   ├── notifications.js   Toasts + notificaciones in-app (bell)
    │   ├── xlsx.js            Export SheetJS (vía CDN)
    │   ├── pdf.js             Helper PDF (vía CDN)
    │   └── seed.js            Datos demo iniciales
    ├── components/
    │   ├── sidebar.js         Navegación lateral
    │   ├── topbar.js          Header con bell, selector de sucursal, perfil
    │   └── modal.js           Modal genérico + confirm
    ├── repos/                 Repositorios (lógica de dominio)
    │   ├── catalog.js         Categorías, marcas, proveedores
    │   ├── products.js        CRUD productos + operaciones de stock
    │   ├── sales.js           Ventas (confirmación, stock, caja, auditoría)
    │   ├── returns.js         Devoluciones + vales + impacto en caja
    │   ├── cash.js            Movimientos de caja, apertura/cierre, gastos
    │   └── counters.js        Números correlativos
    └── modules/               Uno por cada módulo del sidebar (16 total)
        ├── dashboard.js       KPIs + 4 gráficos + feed de actividad
        ├── pos.js             Multi-tab con pagos mixtos
        ├── returns.js         5 casos + vales
        ├── cash.js            Caja + gastos
        ├── inventory.js       Productos, categorías, marcas, proveedores, transferencias
        ├── crm.js             CRM completo con ficha
        ├── balance.js         Saldo filtrado
        ├── profits.js         P&L mensual
        ├── contribution.js    Contribución marginal
        ├── checks.js          Cheques
        ├── employees.js       Empleados + horas
        ├── tasks.js           Kanban
        ├── calendar.js        Calendario
        ├── reports.js         12 reportes XLSX
        ├── history.js         Auditoría
        └── settings.js        Configuración
```

---

## Modelo de datos (IndexedDB)

Ver [`src/core/schema.js`](src/core/schema.js) — 24 stores con índices apropiados. Highlights:

- **Stock**: composite key `{product_id}|{branch_id}` → un stock por combinación producto/sucursal
- **Ventas**: items y payments embebidos; `cost_snapshot` por item para margen histórico preciso
- **Devoluciones**: referencian venta original opcional, emiten vales con código `VALE-XXXXXX` y vencimiento
- **Audit log**: una entrada por cada mutación (create/update/delete/confirm/login/transfer/cash_move/stock_adjust)
- **Counters**: correlativos independientes para ventas, devoluciones, transferencias, vales

### Conceptos clave

- **IVA 21% fijo** (configurable en `format.js`). Los precios se guardan NETOS; el total incluye IVA.
- **Sucursal activa** en sessionStorage — admin/manager pueden cambiar desde el topbar sin re-logear.
- **Multi-tab sync** vía `BroadcastChannel('ingenium')` — confirmar una venta en una pestaña refresca el dashboard en otra.
- **Snapshot pattern** — costos, precios y nombres se congelan en cada venta para auditoría y cálculos de CM correctos aun si después se edita el producto.

---

## Estado de los Sprints

- [x] **Sprint 1 — Fundaciones**: shell, sidebar, topbar, router, IndexedDB, auth, audit, seed
- [x] **Sprint 2 — Catálogo**: CRUD productos, categorías, marcas, proveedores, stock multi-sucursal
- [x] **Sprint 3 — POS**: multi-pestaña, descuentos, edición de precio, pagos mixtos, borradores
- [x] **Sprint 4 — Caja + Devoluciones**: apertura/cierre, gastos, 5 casos de devolución, vales
- [x] **Sprint 5 — Finanzas**: saldo, ganancias, contribución marginal, cheques
- [x] **Sprint 6 — Gente**: CRM, empleados con horas, tareas kanban
- [x] **Sprint 7 — Ops**: transferencias, calendario, 12 reportes XLSX, historial, configuración
- [x] **Sprint 8 — Dashboard**: KPIs + 4 gráficos (Chart.js) + feed de actividad
- [x] **Sprint 9 — QA + README**: este documento

### Fase 2 — Producción (backlog)

- Backend Node.js + Fastify + Prisma
- PostgreSQL en Railway
- Autenticación JWT (reemplaza PIN local)
- Deploy desde GitHub Actions
- Integración TiendaNube (OAuth)
- Parser de facturas con Claude API
- App Android / iOS (React Native)

---

## QA Runthrough — Checklist de flujos críticos

### Autenticación y sesión
- [ ] Login con PIN correcto → redirige a `/dashboard` con toast de bienvenida
- [ ] Login con PIN incorrecto → muestra error
- [ ] Cerrar sesión (sidebar o Configuración) → vuelve a `index.html`
- [ ] Cambiar sucursal activa desde topbar → KPIs del dashboard se refrescan

### POS
- [ ] Crear venta con 1 producto → confirmar → descuenta stock, registra movimiento de caja (si cash), genera entrada en audit
- [ ] Venta con pago mixto (50% cash + 50% tarjeta) → valida suma igual a total
- [ ] Editar precio unitario con doble click → subtotal se recalcula
- [ ] Aplicar descuento global % → se refleja en total
- [ ] Crear segunda pestaña POS → guardar borrador → refrescar → borrador persiste
- [ ] Abrir buscador con Enter sobre un producto → se agrega al carrito

### Devoluciones
- [ ] Caso 1: Devolución total con reintegro cash → stock reingresa, caja disminuye
- [ ] Caso 2: Devolución con vale → stock reingresa, vale creado con código VALE-XXXXXX y vencimiento
- [ ] Caso 3: Cambio exacto → stock reingresa los devueltos, decrementa los nuevos, sin caja
- [ ] Caso 4: Cambio con diferencia a favor cliente → vale o efvo según selección
- [ ] Caso 5: Cambio con cliente paga diferencia → caja aumenta

### Caja
- [ ] Abrir día → no permite abrir dos veces el mismo día
- [ ] Registrar gasto en cash → caja disminuye; gasto en tarjeta → caja no cambia
- [ ] Cierre → calcula diferencia entre esperado y contado
- [ ] Export XLSX → archivo con movimientos

### Inventario
- [ ] Crear producto → aparece con stock 0 en ambas sucursales
- [ ] Ajustar stock +5 → queda auditado con razón
- [ ] Transferir 3 unidades Lomas → Banfield → stock origen -3, destino +3, transferencia con número
- [ ] Eliminar producto → borra stock de todas las sucursales

### Finanzas
- [ ] Saldo con filtro "hoy" → muestra ventas y devoluciones del día
- [ ] Ganancias → P&L del mes actual vs anterior
- [ ] Contribución marginal por categoría → top N con CM% correcto
- [ ] Cheques: crear pendiente con vencimiento en 2 días → aparece notificación al reloguear

### CRM / Gente
- [ ] Crear cliente con cumpleaños este mes → aparece en filtro
- [ ] Ficha de cliente muestra sus compras con totales correctos
- [ ] Marcar un turno de empleado con hora de entrada/salida → pago estimado se recalcula
- [ ] Arrastrar tarea de "Pendiente" a "En curso" → persiste

### Meta
- [ ] Calendario del mes muestra cumpleaños, vencimientos de cheques y feriados
- [ ] Crear evento → aparece en el día, editable, borrable
- [ ] Descargar cualquier reporte XLSX → se genera el archivo con las hojas
- [ ] Historial: filtrar por acción "delete" y entidad "producto" → muestra solo borrados
- [ ] Configuración → cambiar nombre de empresa → persiste tras recargar
- [ ] Resetear demo → borra todo y re-siembra

### Dashboard
- [ ] KPIs muestran números reales (no hardcoded)
- [ ] Gráfico "últimos 30 días" renderiza con datos de ventas
- [ ] Accesos rápidos navegan a los módulos correctos
- [ ] Al confirmar una venta en otra pestaña, el dashboard se refresca automáticamente

---

## Stack técnico

- **Vanilla JavaScript ES Modules** (sin build step)
- **Tailwind CSS** vía CDN (con preset custom: color #d82f1e, fondo #fff8f4)
- **Plus Jakarta Sans** + **Material Symbols Outlined**
- **IndexedDB** (wrapper propio, estilo Dexie)
- **SheetJS** (XLSX export) vía CDN
- **Chart.js** vía CDN
- **BroadcastChannel** para sincronización multi-pestaña
- **Hash-based routing** con lazy imports

### Dependencias externas (CDN)

```html
<script src="https://cdn.tailwindcss.com?plugins=forms,container-queries"></script>
<script src="https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans..." />
<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined..." />
```

---

## Troubleshooting

**"La caja ya fue abierta hoy"** — Un solo movimiento de apertura por día por sucursal. Usá ajuste manual si necesitás reponer.

**Los cambios en un producto no se reflejan en ventas pasadas** — Correcto. Las ventas capturan `cost_snapshot` y `unit_price` al momento de confirmar. Es la base de la ganancia histórica auditada.

**El dashboard muestra datos de la otra sucursal** — Revisá el selector de sucursal en el topbar. El dashboard filtra por `activeBranchId()`.

**IndexedDB bloqueado** — Cerrá otras pestañas de la app o usá Configuración → Zona peligrosa → Resetear.

---

## Licencia

Propietario. Prohibida su redistribución sin autorización.
