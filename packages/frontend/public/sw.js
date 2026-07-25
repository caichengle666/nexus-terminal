const CACHE_PREFIX = 'nexus-terminal-';
const APP_CACHE = `${CACHE_PREFIX}app-v2`;
const ASSET_CACHE = `${CACHE_PREFIX}assets-v2`;
const APP_SHELL = [
  '/index.html',
  '/manifest.json',
  '/icons/icon-144x144.png',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png',
];
const NETWORK_ONLY_PREFIXES = ['/api', '/ws', '/uploads'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(APP_CACHE);
    await Promise.all(APP_SHELL.map(async (url) => {
      try {
        const response = await fetch(new Request(url, { cache: 'reload' }));
        if (response.ok) await cache.put(url, response);
      } catch (error) {
        console.warn(`[ServiceWorker] Failed to precache ${url}:`, error);
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    const outdatedCaches = cacheNames.filter(name => (
      name.startsWith(CACHE_PREFIX) && name !== APP_CACHE && name !== ASSET_CACHE
    ));
    await Promise.all(outdatedCaches.map(name => caches.delete(name)));
    await self.clients.claim();

    if (outdatedCaches.length > 0) {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      clients.forEach(client => client.postMessage({ type: 'PWA_UPDATE_READY' }));
    }
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (NETWORK_ONLY_PREFIXES.some(prefix => url.pathname.startsWith(prefix))) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(APP_CACHE);
          await cache.put('/index.html', response.clone());
        }
        return response;
      } catch {
        return (await caches.match('/index.html')) || Response.error();
      }
    })());
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith((async () => {
      const cache = await caches.open(ASSET_CACHE);
      const cachedResponse = await cache.match(request);
      const networkResponse = fetch(request).then(async response => {
        if (response.ok) await cache.put(request, response.clone());
        return response;
      }).catch(() => cachedResponse || Response.error());
      return cachedResponse || networkResponse;
    })());
  }
});
