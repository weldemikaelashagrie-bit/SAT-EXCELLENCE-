const CACHE_NAME = 'sat-excellence-shell-v237';
const APP_SHELL = [
  './',
  './index.html',
  './collections.js',
  './shared-data.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png'
];
const CDN_ASSETS = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL);
    // Cache the Supabase client when online so the app shell can still load offline.
    await Promise.all(CDN_ASSETS.map(async url => {
      try { await cache.add(new Request(url, {mode: 'no-cors'})); }
      catch (error) { console.warn('Optional offline library cache failed:', error); }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith('sat-excellence-shell-') && key !== CACHE_NAME).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // The Supabase JavaScript client is a required app dependency; serve its cached copy offline.
  if (CDN_ASSETS.some(asset => url.href === asset)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);
      if (cached) return cached;
      try {
        const fresh = await fetch(request);
        if (fresh && (fresh.ok || fresh.type === 'opaque')) await cache.put(request, fresh.clone());
        return fresh;
      } catch (_) {
        return new Response('Supabase client is not cached. Connect to the internet and reload once.', {status: 503, headers: {'Content-Type':'text/plain'}});
      }
    })());
    return;
  }

  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        const cache = await caches.open(CACHE_NAME);
        cache.put('./index.html', fresh.clone());
        return fresh;
      } catch (_) {
        return (await caches.match(request)) || (await caches.match('./index.html'));
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    try {
      const fresh = await fetch(request);
      if (fresh && fresh.ok) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(request, fresh.clone());
      }
      return fresh;
    } catch (_) {
      return new Response('Offline and this resource is not cached.', {status: 503, headers: {'Content-Type':'text/plain'}});
    }
  })());
});
