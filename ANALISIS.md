# Análisis exhaustivo — Ingenium POS

**Fecha:** 2026-04-18
**Autor:** Auditoría post-sprint 9
**Contexto:** Sistema completo de 9 sprints (Auth → POS → Inventario → Devoluciones → Caja → CRM → Finanzas → Gente → Meta + Dashboard/QA). Smoke-test ejecutado en navegador: **16 módulos cargan sin errores de render**, **POS end-to-end OK** (venta simple $54.45 + venta mixta con 2 pagos y dto 10% = $57.50), **auditoría, saldo y caja se actualizan en vivo**.

Este documento enumera bugs reales observados, deuda técnica y sugerencias — con prioridad (🔴 crítico · 🟡 alto · 🟢 mejora). Todo lo señalado es accionable y está ubicado por archivo/línea cuando corresponde.

---

## 1. Bugs confirmados durante QA

### 🔴 B-1 · `renderCart` falla después de confirmar venta
- **Dónde:** [src/modules/pos.js:40](src/modules/pos.js#L40), stack: `renderCart (pos.js:267)` ← `on(EV.STOCK_CHANGED) (pos.js:40)` ← `confirm (sales.js:91)`.
- **Qué pasa:** tras `confirmSale()`, el evento `STOCK_CHANGED` llega al listener del POS que intenta `container.innerHTML = …` pero el contenedor ya fue reemplazado por el modal de confirmación / la vista destino. Consola: `Error: Cannot set properties of null (setting 'innerHTML')`.
- **Impacto:** sólo un error silencioso en consola (la venta ya se confirmó), pero ensucia el log de auditoría implícito y bloquea cualquier listener encolado.
- **Fix sugerido:** en `mount()` guardar `AbortController` y, al re-mount, abortar; o chequear `document.contains(container)` dentro de `renderCart` y salir temprano.

### 🔴 B-2 · Vendedor no filtrado por sucursal
- **Dónde:** [src/modules/pos.js:60-61](src/modules/pos.js) y [src/modules/balance.js] (filtro vendedor).
- **Qué pasa:** el dropdown de VENDEDOR y el filtro de vendedor en Saldo muestran los 4 empleados (2 de Lomas + 2 de Banfield). En Lomas no deberían aparecer Mateo Gomez ni Camila Lopez (Banfield).
- **Impacto:** un cajero de Lomas puede asignar una venta a un vendedor que no trabaja ahí → contaminación de comisiones y auditoría.
- **Fix sugerido:** filtrar `state.employees` por `activeBranchId()` y sólo si `role === 'cashier' || role === 'seller'`. En balance.js idem.

### 🟡 B-3 · Router ignora navegación al mismo route
- **Dónde:** [src/core/router.js].
- **Qué pasa:** tras confirmar la venta, la app queda en `/pos` pero el `<main>` aún muestra el Dashboard anterior (porque `confirmSale` probablemente pushea `#/pos` pero el router detecta "misma ruta" y no re-renderea). Requiere reload manual para volver al POS.
- **Fix sugerido:** en `startRouter`, tratar `hashchange` con mismo hash como re-mount forzado; o exportar `forceRender()` público.

### 🟡 B-4 · Drift de precisión flotante en pago inicial
- **Dónde:** [src/modules/pos.js] botón `+ Agregar` pago autocompleta el monto faltante.
- **Qué pasa:** al agregar un pago, el valor pre-cargado es `57.499199…` (viene de IVA = `net * 0.21` en JS Number). Se ve como `$ 57,50` redondeado pero el `value` del input expone la basura.
- **Fix sugerido:** en [src/core/format.js] agregar `round2(n) = Math.round(n*100)/100` y aplicarlo tanto en el input value como en el total de Sales.computeTotals.

### 🟡 B-5 · Labels de login sin asociar
- **Dónde:** `index.html` (3 instancias).
- **Qué pasa:** Lighthouse y a11y tree marcan "No label associated with a form field" en los inputs de usuario/clave/sucursal.
- **Fix sugerido:** envolver cada input en `<label>` con `for="…"` o añadir `aria-label="Usuario"`, `aria-label="Contraseña"`, `aria-label="Sucursal"`.

### 🟢 B-6 · Petición 404 en consola
- **Qué pasa:** un recurso (probablemente `favicon.ico`) devuelve 404 en el primer load.
- **Fix sugerido:** agregar `assets/favicon.svg` o `<link rel="icon" href="data:,">` en `<head>` para silenciar.

### 🟢 B-7 · Tailwind CDN warning
- **Qué pasa:** `cdn.tailwindcss.com should not be used in production`.
- **Fix:** mencionado en README; decisión consciente para prototipo.

---

## 2. Gaps funcionales detectados

### 🔴 G-1 · No hay validación de stock en POS multi-tab
Si el vendedor abre 2 pestañas POS con el mismo producto con stock = 1 y confirma ambas, la segunda pasa (stock queda en −1). `Sales.confirm` valida stock al iniciar pero no bloquea la transacción IndexedDB en `readwrite` sobre `stock` durante todo el flujo.
- **Fix:** envolver `confirm()` en `tx(['sales','sale_items','stock','cash_movements','audit_log'], 'readwrite')` y re-leer stock dentro del tx antes de hacer `put`.

### 🟡 G-2 · Devolución sin caja abierta no está bloqueada
`returns.process()` permite devolución aunque `cash.isOpen(branch) === false`. El reembolso en efectivo crea un `cash_movement` que aparece en un "día sin caja abierta".
- **Fix:** en [src/repos/returns.js] al inicio validar `cash.isDayOpen(branch_id, today)` y sólo permitir nota de crédito si no.

### 🟡 G-3 · Cierre de caja no bloquea nuevas ventas
Tras `closeDay`, el POS sigue aceptando ventas y las imputa al día siguiente. El caso real: querés cerrar a las 20:00 y que las ventas post-cierre vayan al día siguiente (OK) PERO que quede explícito en UI que la caja está cerrada.
- **Fix:** topbar con badge "Caja cerrada" + toast de advertencia al confirmar venta.

### 🟡 G-4 · Transferencia entre sucursales no exige remito
Stock origen baja y destino sube en una sola transacción, pero no queda registro atómico como documento (número de transferencia, motivo, responsable). Sólo entrada en `audit_log`.
- **Fix:** crear store `transfers` con `{id, number, from_branch, to_branch, items[], user_id, datetime, notes}` y mostrar historial.

### 🟢 G-5 · Cheques no generan movimiento en Saldo automáticamente
Cuando un cheque se marca como "cobrado", debería crear un `cash_movement` tipo `deposit` en la sucursal asignada. Hoy queda aislado.

### 🟢 G-6 · Calendario sin edición de eventos seed
El calendario permite crear/ver eventos pero no hay forma obvia de editar un evento pasado.

### 🟢 G-7 · Kanban de tareas no persiste orden intra-columna
Si arrastrás 2 tareas a "En progreso", no se guarda el orden entre ellas — sólo la columna.

### 🟢 G-8 · Reportes no permiten comparar períodos
No hay "mes actual vs. mes anterior" ni "sucursal vs. sucursal" lado a lado.

---

## 3. Modelo de datos — sugerencias

### 🟡 D-1 · `sale.items[].cost_snapshot` debe incluir método de costeo
Hoy se snapshot el costo vigente al confirmar la venta. Pero si mañana se implementa FIFO/promedio real, el historial queda inconsistente. Agregar `cost_method: 'last' | 'avg' | 'fifo'`.

### 🟡 D-2 · No hay `updated_at`/`created_at` uniforme
Algunos records tienen `datetime`, otros `created_at`, otros nada. Estandarizar en todas las entidades facilita debugging y sync futuro.

### 🟡 D-3 · `stock` usa clave compuesta string `product_id|branch_id`
Funciona pero dificulta queries por índice. IndexedDB soporta `keyPath` compuesto array `['product_id','branch_id']`.

### 🟢 D-4 · `payment_methods` como config singleton
Vive en `config` store como blob. Si crece a políticas por sucursal (p.ej., "MercadoPago sólo en Lomas") necesita su propia tabla.

### 🟢 D-5 · Falta `tenant_id` / multi-empresa
Todo el esquema asume 1 empresa. Si mañana querés vender la app a otro negocio, cada store necesita `tenant_id` o cada empresa una DB separada.

### 🟢 D-6 · Numeración correlativa sin reset anual
`counters` arma `#1, #2, …` sin separación por año. AFIP exige numeración por año/punto de venta.

---

## 4. UX / UI

### 🔴 U-1 · POS: no hay atajo de teclado obvio
Faltan F-keys: F1=buscar, F2=agregar cliente, F3=descuento, F4=pagar, F9=confirmar. En un local real, el cajero no usa mouse.

### 🟡 U-2 · Selector de sucursal en topbar sin confirmación
Cambiar de Lomas a Banfield con carrito abierto pierde el carrito silenciosamente.
- **Fix:** `confirmModal('Hay una venta en curso. ¿Cambiar sucursal igual?')`.

### 🟡 U-3 · Modal de confirmar venta no permite imprimir ticket
Hoy sólo muestra total + "Listo". Falta botón "Imprimir" (aunque sea `window.print()` de un layout mínimo) y "Nueva venta".

### 🟡 U-4 · CRM: sin campo "historia de compras" en ficha de cliente
La ficha existe pero lista sólo datos. Debería mostrar top productos, ticket promedio, última compra, deuda.

### 🟡 U-5 · Dashboard: KPIs sin comparativa
"$54.45 hoy" no dice nada sin el "vs. ayer" o "vs. promedio mes". Agregar flecha ↑/↓ con %.

### 🟢 U-6 · Inventario: no hay vista "por sucursal" consolidada
Ves stock de la sucursal activa. Falta toggle "ambas" con columnas Lomas / Banfield.

### 🟢 U-7 · Tablas no recuerdan orden/filtro al volver
Si filtrás en Historial y navegás al Dashboard y volvés, perdés filtros. Persistir en `sessionStorage`.

### 🟢 U-8 · Toast no tiene botón "deshacer"
Una venta anulable vía toast "Venta #3 confirmada · Deshacer" durante 5s reduciría pánico.

### 🟢 U-9 · Sin estado vacío ilustrado
Cuando una lista está vacía (Cheques, Tareas, Empleados), muestra "Sin resultados" plano. Una ilustración + CTA "Crear primer cheque" mejora el onboarding.

### 🟢 U-10 · Responsive incompleto
Todo está pensado para 1280+. En mobile (caja móvil, gerente consultando desde el celular) el sidebar colapsa pero el POS se rompe.

### 🟢 U-11 · No hay modo oscuro
Los colores están hardcodeados (`#fff8f4`, `#241a0d`). Tailwind permite `dark:` trivialmente.

---

## 5. Accesibilidad

- 🟡 **A-1:** foco visible inconsistente. Algunos botones no muestran ring al tabular.
- 🟡 **A-2:** iconos de Material Symbols sin `aria-hidden` → screen readers leen "shopping_cart shopping_cart".
- 🟡 **A-3:** contraste `text-[#7d6c5c]` sobre `#fff8f4` está en el borde de WCAG AA para cuerpo.
- 🟢 **A-4:** modales sin `role="dialog"` + `aria-modal`.
- 🟢 **A-5:** sin `lang="es-AR"` en `<html>`.

---

## 6. Seguridad / Datos

### 🔴 S-1 · Contraseñas en texto plano
`users.password` se guarda tal cual en IndexedDB. Cualquiera con devtools abre `ingenium` DB y las lee. Usar `bcrypt`/`scrypt` via WebCrypto (`PBKDF2` con 100k iteraciones + salt random por usuario).

### 🔴 S-2 · Sin expiración de sesión
Una vez logueado, la sesión dura hasta `logout` explícito. Agregar timeout por inactividad (15-30 min) + refresh en actividad.

### 🟡 S-3 · `activeBranchId` manipulable vía console
`setActiveBranch('br_otra_ficticia')` no valida que exista ni que el user tenga permiso. Validar contra `user.allowed_branches`.

### 🟡 S-4 · Audit log mutable
Nada impide que alguien con acceso a devtools modifique `audit_log`. Para un registro no repudiable, hashear cada entrada encadenadamente (como blockchain), o replicar a backend.

### 🟢 S-5 · Sin backup automático
IndexedDB sobrevive F5 pero un "Borrar datos del sitio" en Chrome destruye todo. Schedular export JSON/XLSX diario a disco + recordatorio.

### 🟢 S-6 · CSP ausente
Sin `<meta http-equiv="Content-Security-Policy">`. Inyectar un script externo es trivial.

---

## 7. Performance

- 🟡 **P-1:** Dashboard recalcula 30 días de ventas cada `refresh` sin memo. Con 10k ventas empezará a tardar. Cachear por `{branch, month}` en memoria.
- 🟡 **P-2:** `Audit.list()` devuelve todo el log; Historial filtra en cliente. Con 50k entradas, el `filter` bloquea el main thread. Paginar o usar índice IDB `by-datetime`.
- 🟢 **P-3:** Charts se destruyen/recrean enteros en cada evento. Chart.js soporta `.update('none')` que es mucho más barato.
- 🟢 **P-4:** Tailwind CDN descarga todo el framework; en prod con `tailwindcli`/PostCSS bajás a ~20KB.
- 🟢 **P-5:** Sin `<link rel="preconnect">` a los CDN (Google Fonts, jsdelivr) → LCP sufre.

---

## 8. Arquitectura / Código

### 🟡 C-1 · Módulos de UI renderean strings HTML
Cada `render()` hace `el.innerHTML = \`…\``. Funciona pero:
- pierde state (scroll, foco) en cada refresh,
- fuerza re-bind de todos los `addEventListener`,
- XSS si un nombre de producto trae `<script>`.
- **Fix a largo plazo:** migrar a [lit-html](https://lit.dev/) (20KB, sin build step, templating seguro).

### 🟡 C-2 · No hay tests
0% coverage. Al menos `src/repos/sales.js` (computeTotals, confirm) y `src/repos/returns.js` (5 casos) deberían tener tests de unidad. Vitest puede correr sin build con `vite test`.

### 🟡 C-3 · Event bus sin tipos
`on(EV.SALE_CONFIRMED, cb)` pasa `cb(payload)` pero el payload no está documentado. TypeScript + Zod en los payloads o al menos JSDoc `@param`.

### 🟢 C-4 · Duplicación en `repos/catalog.js` mk() factory
El factory genérico está bien, pero cuando quieras validaciones específicas (p.ej., "una marca no puede borrarse si tiene productos"), necesitás escapar al patrón. Preferir repositories individuales con composición.

### 🟢 C-5 · `state` local en módulos (p.ej. history.js)
State vive en closure del módulo → si el user navega a Historial, filtra, va a Dashboard y vuelve, el state persiste pero el render no lo usa bien en algunos casos. Mover a un `stores/` con subscribe/notify.

### 🟢 C-6 · Hash router sin parámetros tipados
`#/products/123` funciona pero no hay una convención. Adoptar `router.registerRoute('/products/:id', mount)` con regex interno.

### 🟢 C-7 · Magic strings para acciones de audit
`Audit.log({action: 'confirm', entity: 'venta'})` — los strings viven esparcidos. Crear `AUDIT_ACTIONS = {SALE_CONFIRM: 'sale.confirm', …}`.

### 🟢 C-8 · No hay linter / formatter
Agregar ESLint + Prettier + Husky pre-commit evita los 80 lugares donde `let` debería ser `const`.

---

## 9. Negocio / producto (wishlist Fase 2)

1. **Integración AFIP/ARCA** — facturación electrónica real con CUIT del cliente (hoy el campo existe pero no se valida ni se firma).
2. **Tickets QR** — generar PDF con QR linkeando a un endpoint público "verificar ticket" (anti-fraude).
3. **Comisiones por vendedor** — calcular % sobre Neto o Margen por vendedor/mes, con reglas por categoría.
4. **Objetivos y metas** — "Vender $500k en el mes" con progress bar en Dashboard.
5. **Alertas proactivas** — "Stock de X llegó a 0", "Cheque Y vence mañana", "Cliente Z no compra hace 60 días".
6. **Programa de fidelidad** — puntos por compra, canje como descuento.
7. **Marketplace integrations** — MELI ya está "Publicar", falta sync bidi de stock y ventas.
8. **Módulo de compras** — hoy hay proveedores pero no hay OC ni recepción de mercadería → stock sube "por arte de magia" en inventario.
9. **Multi-caja por sucursal** — Lomas podría tener 2 cajas físicas (Caja 1 / Caja 2). Hoy una sucursal = una caja.
10. **Turnos de empleados con reloj de fichada** — más allá del listado básico, integrar con horas trabajadas y liquidación.
11. **Presupuestos / cotizaciones** — guardar un carrito como "presupuesto válido 7 días" y convertirlo a venta.
12. **Reserva de productos** — "separá 1 Turbo Racer por 48hs para cliente X".

---

## 10. Priorización sugerida (próximo sprint)

Si sólo tenés 1 semana, atacar:

1. **B-1** (renderCart después de confirmar) — 30 min
2. **B-2** (vendedor filtrado por sucursal) — 20 min
3. **B-4** (floating point en pago) — 30 min
4. **G-1** (race condition stock multi-tab) — 2 h
5. **S-1** (hash de contraseñas) — 3 h
6. **U-3** (imprimir ticket) — 2 h
7. **C-2** (tests de sales + returns) — 1 día

Total ≈ 2 días efectivos → sistema notablemente más robusto.

---

## 11. Cierre

El prototipo cumple los 9 sprints planteados: las 4 operaciones comerciales críticas (venta, devolución, caja, inventario) funcionan end-to-end, la auditoría registra todo, los KPIs del dashboard se sincronizan en vivo, y la UI se mantiene coherente en 16 módulos. Los bugs encontrados son típicos de prototipos vanilla-JS sin build pipeline y se pueden resolver en días, no semanas.

El mayor riesgo estructural es **S-1 (passwords en texto plano)** combinado con **G-1 (race condition en stock)** — ambos bloquean cualquier uso real en tienda. El resto es pulido, UX y features de roadmap.

Sistema queda abierto en `http://localhost:8080/app.html`.
