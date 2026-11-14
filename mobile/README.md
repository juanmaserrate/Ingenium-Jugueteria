# Ingenium Ventas — app móvil (Expo / Android)

App nativa (React Native + Expo) para ver las ventas de **Lomas**, **Banfield** y **las dos juntas**, con **notificaciones push** cuando se confirma una venta. Lee del backend de Ingenium (el mismo que usa el sistema web).

## Qué hace
- **Login** con sucursal + usuario + PIN (el mismo del sistema).
- **Panel**: tarjeta "Las dos (juntas)" + una por sucursal (admin). Muestra ventas de **hoy** (monto y cantidad) y del **mes**. Se refresca solo cada 30 s y deslizando.
- **Push**: al confirmarse una venta en cualquier sucursal, llega una notificación (`Venta #123 · Banfield · $X · N ítems`).

> El encargado (no admin) ve solo su sucursal. El dueño (admin) ve las dos y el consolidado.

## Requisitos (una sola vez)
1. Node 18+ y la CLI de EAS: `npm i -g eas-cli`
2. Una cuenta de **Expo** (gratis): https://expo.dev → `eas login`

## Correr / probar rápido (sin compilar)
```bash
cd mobile
npm install
npx expo start
```
Abrí la app **Expo Go** (Play Store) en el celu y escaneá el QR. Sirve para probar el panel y las push de prueba en Android.

## Compilar el APK instalable (eas build)
```bash
cd mobile
eas login
eas init          # crea el proyecto en Expo y completa extra.eas.projectId en app.json
eas build -p android --profile preview
```
Al terminar te da un link para **descargar el APK** e instalarlo en el Android (hay que permitir "instalar apps de orígenes desconocidos").

- Para subir a Google Play más adelante: `eas build -p android --profile production` (genera un .aab).

## Push en Android: configurar FCM (obligatorio para el APK)
Las notificaciones push en un build propio de Android pasan por **Firebase Cloud Messaging (FCM)**. Una sola vez:
1. Creá un proyecto en https://console.firebase.google.com → agregá una **app Android** con el package **`com.ingenium.ventas`** (el mismo de `app.json`).
2. Descargá el **`google-services.json`** y dejalo en `mobile/` (al lado de `app.json`).
3. Subí las credenciales FCM V1 a Expo: `eas credentials` → Android → *Push Notifications: FCM V1* → subí la **service account key** (JSON) que bajás de Firebase → *Configuración del proyecto → Cuentas de servicio → Generar nueva clave privada*.

Con eso, el token del dispositivo (ExponentPushToken) que registra la app ya recibe las push que manda el backend.

## Configuración
- **URL del backend**: `app.json` → `expo.extra.apiBase` (ya apunta a producción Railway).
- **Nombre/ícono**: `app.json`. Para un ícono propio, agregá `assets/icon.png` (1024×1024) y referencialo en `expo.icon`.

## Cómo funciona la push (backend)
- La app registra su token en `POST /api/push/register` al iniciar sesión.
- Al confirmar una venta, el backend (`services/sales.ts` → `notifySalePush`) envía el aviso vía Expo Push API a todos los dispositivos registrados.
- Tokens caídos (DeviceNotRegistered) se limpian solos.
