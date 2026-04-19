// Service Worker Ingenium — cache del shell para modo offline.
// Estrategia:
//   - Precache del shell al instalar (index.html, app.html, CSS, módulos JS).
//   - Navegación: network-first con fallback a app.html cacheado (SPA shell).
//   - Assets estáticos mismo origen: cache-first con refresh en background.
//   - CDNs (tailwind, fonts, xlsx, chart.js): stale-while-revalidate.
//   - API (/api, /auth, /webhooks): NUNCA cachear — se deja a fetch normal.
//     Cuando no hay red, la cola local de sync-queue.js se encarga.

const VERSION = 'ingenium-v2-tn';
const SHELL_CACHE = `${VERSION}-shell`;
const ASSETS_CACHE = `${VERSION}-assets`;
const CDN_CACHE = `${VERSION}-cdn`;

const SHELL_ASSETS = [
  './',
  './index.html',
  './app.html',
  './assets/css/custom.css',
  './src/config/theme.js',
  './src/core/api.js',
  './src/core/audit.js',
  './src/core/auth.js',
  './src/core/backup.js',
  './src/core/crypto.js',
  './src/core/db.js',
  './src/core/events.js',
  './src/core/filter-state.js',
  './src/core/format.js',
  './src/core/notifications.js',
  './src/core/pdf.js',
  './src/core/router.js',
  './src/core/schema.js',
  './src/core/seed.js',
  './src/core/sync-queue.js',
  './src/core/xlsx.js',
  './src/components/empty-state.js',
  './src/components/modal.js',
  './src/components/sidebar.js',
  './src/components/topbar.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // addAll falla si uno solo falla; usamos Promise.allSettled tolerante.
      await Promise.allSettled(SHELL_ASSETS.map((url) => cache.add(url)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => !k.startsWith(VERSION))
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

function isApiRequest(url) {
  return (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/auth/') ||
    url.pathname.startsWith('/webhooks/') ||
    url.pathname.startsWith('/images/')
  );
}

function isCdnRequest(url) {
  return (
    url.hostname === 'cdn.tailwindcss.com' ||
    url.hostname === 'cdn.jsdelivr.net' ||
    url.hostname === 'fonts.googleapis.com' ||
    url.hostname === 'fonts.gstatic.com'
  );
}

async function cacheFirst(event, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(event.request);
  if (cached) {
    // Refresh en background sin bloquear
    event.waitUntil(
      fetch(event.request)
        .then((res) => {
          if (res && res.ok) cache.put(event.request, res.clone());
        })
        .catch(() => null),
    );
    return cached;
  }
  try {
    const res = await fetch(event.request);
    if (res && res.ok) cache.put(event.request, res.clone());
    return res;
  } catch (err) {
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

async function staleWhileRevalidate(event, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(event.request);
  const networkPromise = fetch(event.request)
    .then((res) => {
      if (res && res.ok) cache.put(event.request, res.clone());
      return res;
    })
    .catch(() => null);
  return cached || (await networkPromise) || new Response('', { status: 504 });
}

async function networkFirstNavigation(event) {
  try {
    const res = await fetch(event.request);
    return res;
  } catch (err) {
    const cache = await caches.open(SHELL_CACHE);
    const url = new URL(event.request.url);
    // Fallback al shell correspondiente
    if (url.pathname.includes('app.html')) {
      return (await cache.match('./app.html')) || Response.error();
    }
    return (
      (await cache.match('./index.html')) ||
      (await cache.match(event.request)) ||
      Response.error()
    );
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Nunca cachear API/auth/webhooks — dejamos pasar para que la cola offline lo maneje.
  if (url.origin === self.location.origin && isApiRequest(url)) return;

  // Navegación HTML: network-first con fallback al shell
  if (req.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(event));
    return;
  }

  // CDNs: stale-while-revalidate
  if (isCdnRequest(url)) {
    event.respondWith(staleWhileRevalidate(event, CDN_CACHE));
    return;
  }

  // Mismo origen: cache-first
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(event, ASSETS_CACHE));
    return;
  }
});

// Permitir que la app fuerce un refresh del SW desde la UI
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
