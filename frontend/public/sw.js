/*
 * Application-shell service worker.
 *
 * WHAT IS CACHED: the static application shell only - the HTML entry
 * document, the hashed JS/CSS bundles Vite emits, the icons, and the
 * manifest. Nothing else, ever.
 *
 * WHAT IS DELIBERATELY NEVER CACHED, and why:
 *
 *   - EVERY API RESPONSE. `/api/` is network-only and its responses are
 *     never written to a cache. Permit content, JSA content, employee
 *     records, notifications, and audit history are authorization-scoped
 *     data: a cached copy would survive the permission that produced it,
 *     could be read after a revocation, and would still be on the device
 *     after the next person signs in. Protected permit data must not
 *     become offline-readable without a deliberate secure offline
 *     design, and there is none.
 *
 *   - THE PDF ENDPOINT, for the same reason and more strongly - it is
 *     the immutable issued document.
 *
 *   - ANYTHING CARRYING AN AUTHORIZATION HEADER. A request with
 *     credentials is not shell content.
 *
 *   - SUPABASE AUTH TRAFFIC. Tokens are never seen, stored, or cached
 *     here.
 *
 * Only same-origin GET requests are considered at all; a POST, PATCH or
 * DELETE is passed straight through, so no mutation can ever be replayed
 * from a cache.
 */

const CACHE_VERSION = 'eset-shell-v1';
const SHELL_URLS = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      // A failure to pre-cache must not block installation - the app
      // still works, it simply has no offline shell.
      .then((cache) => cache.addAll(SHELL_URLS).catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

/** Whether this request is plain, unauthenticated, same-origin shell content. */
function isShellRequest(request) {
  if (request.method !== 'GET') return false;
  if (request.headers.has('authorization')) return false;
  // `no-store` is an explicit instruction from the caller; honour it.
  if (request.cache === 'no-store' || request.cache === 'reload') return false;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith('/api/')) return false;
  if (url.pathname.includes('/auth/')) return false;

  const destination = request.destination;
  return (
    destination === 'document' ||
    destination === 'script' ||
    destination === 'style' ||
    destination === 'font' ||
    destination === 'image' ||
    destination === 'manifest'
  );
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (!isShellRequest(request)) return; // Network only. Nothing is stored.

  // A navigation always prefers the network, so a deployed update is
  // picked up immediately; the cached shell is the offline fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          void caches.open(CACHE_VERSION).then((cache) => cache.put('/index.html', copy));
          return response;
        })
        .catch(() => caches.match('/index.html').then((cached) => cached ?? Response.error())),
    );
    return;
  }

  // Hashed static assets: cache-first is safe, because a new build emits
  // a new filename.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          void caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});

/**
 * Signing out clears the shell cache too. Nothing account-specific is in
 * it, but a clean slate on the device costs nothing and removes any
 * doubt.
 */
self.addEventListener('message', (event) => {
  if (event.data === 'eset:clear-caches') {
    event.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key)))));
  }
});
