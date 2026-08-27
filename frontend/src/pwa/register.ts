/**
 * Service-worker registration.
 *
 * Installed only in a production build - a worker in development would
 * serve stale bundles and confuse local work for no benefit.
 *
 * The worker itself is the security-relevant part; see `public/sw.js`
 * for exactly what it caches (the static application shell) and what it
 * refuses to cache (every API response, every PDF, and anything carrying
 * an authorization header).
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      // An unavailable worker is not a failure: the application works
      // exactly the same, just without an offline shell.
    });
  });
}

/** Asks the worker to drop its caches. Called on sign-out for a clean device state. */
export function clearServiceWorkerCaches(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker.controller?.postMessage('eset:clear-caches');
}
