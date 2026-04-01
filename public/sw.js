const CACHE_VERSION = '4';
const CACHE_NAME = 'goldpot-v' + CACHE_VERSION;
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/css/style.css',
  '/css/goldmine.css',
  '/js/app.js',
  '/js/game.js',
  '/js/goldmine.js',
  '/goldmine.html',
  '/manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle same-origin requests — skip third-party (Stripe, Google Ads, fonts, etc.)
  if (!request.url.startsWith(self.location.origin)) return;

  // Network-first for API calls
  if (request.url.includes('/api/')) {
    event.respondWith(
      fetch(request).catch(() => caches.match(request))
    );
    return;
  }

  // Cache-first for static assets
  event.respondWith(
    caches.match(request).then((cached) => {
      const fetched = fetch(request).then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      }).catch(() => cached);
      return cached || fetched;
    })
  );
});

// ─── Push Notifications ─────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  let data = { title: 'GOLDPOT', body: 'Something exciting is happening!', url: '/' };
  try { data = event.data.json(); } catch (e) { /* keep defaults */ }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🪙</text></svg>",
      badge: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🪙</text></svg>",
      data: { url: data.url || '/' },
      vibrate: [200, 100, 200],
      requireInteraction: true,
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  let url = event.notification.data && event.notification.data.url ? event.notification.data.url : '/';
  // Prevent open redirect — only allow same-origin relative paths
  if (!url.startsWith('/') || url.startsWith('//')) url = '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) return client.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});
