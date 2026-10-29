/**
 * QueHayHoy BRO — Service Worker v4
 * Estrategia: Cache-first para assets estáticos, Network-first para API
 * Soporte offline con fallback page
 */

const CACHE_NAME = 'qhh-bro-v4';
const STATIC_CACHE = 'qhh-static-v4';
const API_CACHE = 'qhh-api-v4';

/* Assets que se cachean en la instalación */
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/pages/home.html',
  '/pages/auth.html',
  '/pages/mapa.html',
  '/pages/venue.html',
  '/pages/perfil.html',
  '/pages/ajustes.html',
  '/pages/offline.html',
  '/css/main.css',
  '/js/app.js',
  '/js/api.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

/* URLs de API que se cachean con Network-first */
const API_CACHE_PATTERNS = [
  /\/api\/events/,
  /\/api\/venues/,
  /\/api\/stories/,
  /\/api\/search/,
];

/* ── Install ── */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => {
        /* Cachear uno a uno para no fallar todo si falta un asset */
        return Promise.allSettled(
          PRECACHE_ASSETS.map(url =>
            cache.add(url).catch(() => console.warn('[SW] No se pudo cachear:', url))
          )
        );
      })
      .then(() => self.skipWaiting())
  );
});

/* ── Activate ── */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== STATIC_CACHE && k !== API_CACHE)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

/* ── Fetch ── */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  /* Ignorar requests no-GET y extensiones del browser */
  if (request.method !== 'GET') return;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  /* API requests: Network-first con cache fallback */
  if (url.pathname.startsWith('/api/') || API_CACHE_PATTERNS.some(p => p.test(url.pathname))) {
    event.respondWith(networkFirst(request, API_CACHE, 8000));
    return;
  }

  /* Assets estáticos (CSS, JS, imágenes): Cache-first */
  if (
    url.pathname.match(/\.(css|js|png|jpg|jpeg|gif|svg|webp|woff|woff2|ico)$/) ||
    url.hostname !== self.location.hostname
  ) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  /* Páginas HTML: Stale-while-revalidate */
  if (url.pathname.endsWith('.html') || url.pathname === '/' || !url.pathname.includes('.')) {
    event.respondWith(staleWhileRevalidate(request, STATIC_CACHE));
    return;
  }

  /* Default: Network con fallback de cache */
  event.respondWith(networkFirst(request, STATIC_CACHE, 5000));
});

/* ── Estrategias ── */
async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return offlineFallback(request);
  }
}

async function networkFirst(request, cacheName, timeout = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(request, { signal: controller.signal });
    clearTimeout(timer);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    clearTimeout(timer);
    const cached = await caches.match(request);
    if (cached) return cached;
    return offlineFallback(request);
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const networkPromise = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);
  return cached || (await networkPromise) || offlineFallback(request);
}

async function offlineFallback(request) {
  const url = new URL(request.url);
  if (url.pathname.endsWith('.html') || !url.pathname.includes('.')) {
    const offline = await caches.match('/pages/offline.html');
    if (offline) return offline;
  }
  return new Response('Sin conexión', { status: 503, statusText: 'Offline' });
}

/* ── Push Notifications ── */
self.addEventListener('push', (event) => {
  if (!event.data) return;
  let data;
  try { data = event.data.json(); }
  catch { data = { title: 'QueHayHoy BRO', body: event.data.text() }; }

  const options = {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    image: data.image || undefined,
    tag: data.tag || 'qhh-notification',
    renotify: true,
    vibrate: [200, 100, 200],
    data: { url: data.url || '/', ...data.extra },
    actions: data.actions || [
      { action: 'open', title: 'Ver', icon: '/icons/icon-96.png' },
      { action: 'dismiss', title: 'Cerrar' },
    ],
  };

  event.waitUntil(self.registration.showNotification(data.title || 'QueHayHoy BRO', options));
});

/* ── Notification Click ── */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'dismiss') return;
  const url = event.notification.data?.url || '/pages/home.html';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      const existing = clientList.find(c => c.url.includes(url) && 'focus' in c);
      if (existing) return existing.focus();
      return clients.openWindow(url);
    })
  );
});

/* ── Background Sync ── */
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-posts') {
    event.waitUntil(syncPendingPosts());
  }
  if (event.tag === 'sync-likes') {
    event.waitUntil(syncPendingLikes());
  }
});

async function syncPendingPosts() {
  try {
    const db = await openDB();
    const pending = await db.getAll('pending-posts');
    for (const post of pending) {
      await fetch('/api/posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${post._token}` },
        body: JSON.stringify(post),
      });
      await db.delete('pending-posts', post.id);
    }
  } catch (e) { console.warn('[SW] syncPendingPosts failed:', e); }
}

async function syncPendingLikes() {
  try {
    const db = await openDB();
    const pending = await db.getAll('pending-likes');
    for (const like of pending) {
      await fetch(`/api/posts/${like.postId}/like`, {
        method: like.action,
        headers: { 'Authorization': `Bearer ${like._token}` },
      });
      await db.delete('pending-likes', like.id);
    }
  } catch (e) { console.warn('[SW] syncPendingLikes failed:', e); }
}

/* ── Minimal IndexedDB helper ── */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('qhh-offline', 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('pending-posts'))
        db.createObjectStore('pending-posts', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('pending-likes'))
        db.createObjectStore('pending-likes', { keyPath: 'id' });
    };
    req.onsuccess = e => {
      const db = e.target.result;
      resolve({
        getAll: (store) => new Promise((res, rej) => {
          const tx = db.transaction(store, 'readonly');
          const req2 = tx.objectStore(store).getAll();
          req2.onsuccess = () => res(req2.result);
          req2.onerror = () => rej(req2.error);
        }),
        delete: (store, key) => new Promise((res, rej) => {
          const tx = db.transaction(store, 'readwrite');
          const req2 = tx.objectStore(store).delete(key);
          req2.onsuccess = () => res();
          req2.onerror = () => rej(req2.error);
        }),
      });
    };
    req.onerror = () => reject(req.error);
  });
}

/* ── Periodic Background Sync (si el browser lo soporta) ── */
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'update-content') {
    event.waitUntil(updateCachedContent());
  }
});

async function updateCachedContent() {
  try {
    const cache = await caches.open(API_CACHE);
    const keys = await cache.keys();
    await Promise.allSettled(keys.map(req => fetch(req).then(res => {
      if (res.ok) cache.put(req, res);
    })));
  } catch {}
}
