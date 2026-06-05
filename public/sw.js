/**
 * Obelisk Service Worker
 *
 * Strategy: network-first with fallback to cache.
 * This keeps the app fresh on every load while still enabling Chrome's
 * "Add to Home Screen" install prompt and providing basic offline resilience
 * for previously visited assets.
 */

const CACHE_NAME = 'obelisk-v1';

// Immediately activate on first install — no waiting for old tabs to close.
self.addEventListener('install', () => self.skipWaiting());

// Claim all open clients so the SW is controlling from the first page load.
self.addEventListener('activate', e => e.waitUntil(clients.claim()));

self.addEventListener('fetch', e => {
  // Only intercept GET requests.
  if (e.request.method !== 'GET') return;

  // Don't intercept Supabase API / storage requests — always go to network.
  const url = e.request.url;
  if (url.includes('supabase.co') || url.includes('gemini') || url.includes('googleapis')) return;

  e.respondWith(
    fetch(e.request)
      .then(response => {
        // Cache successful responses for the app shell assets.
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return response;
      })
      .catch(() => {
        // Network failed — serve from cache if available.
        return caches.match(e.request);
      })
  );
});
