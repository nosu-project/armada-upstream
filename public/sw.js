/**
 * Armada Service Worker
 *
 * Two responsibilities:
 *  1. App-shell caching: cache the SPA shell and static assets on install so
 *     the app loads offline and qualifies as an installable PWA.
 *  2. Web Push: receive push notifications from the relay and route
 *     notificationclick to the correct conversation.
 *
 * Caching strategy
 * ----------------
 * - Static assets (JS/CSS/fonts/images — hashed filenames): cache-first,
 *   populate on first fetch, never stale.
 * - Navigation requests (HTML): network-first, fall back to cached /index.html
 *   so the SPA can boot offline.
 * - Everything else (WebSocket upgrades, Nostr relay, LiveKit, external URLs):
 *   straight to network — do not cache.
 *
 * The relay push payload: { title, body, icon, badge, data: { url, tag } }.
 */

// Replaced with the real build stamp by the armada-build-stamp Vite plugin.
// A new deploy therefore changes this file's bytes (the browser re-checks
// sw.js on navigation, bypassing the HTTP cache) and rotates the cache name,
// so the activate step below drops the previous deploy's shell cache.
const BUILD = "__BUILD_STAMP__";
const CACHE = "armada-shell-" + BUILD;

// App-shell assets to warm on install. Vite hashes JS/CSS so they stay
// cache-first once cached; index.html is the SPA entry point.
const PRECACHE = ["/", "/index.html", "/theme.js", "/favicon.svg", "/favicon.png", "/apple-touch-icon.png", "/logo-192.png", "/logo-512.png", "/maskable-192.png", "/maskable-512.png", "/manifest.json"];

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

self.addEventListener("install", (event) => {
  // Take control immediately so push and caching work on first install.
  self.skipWaiting();
  event.waitUntil(
    // cache: "reload" bypasses the HTTP cache so a freshly-updated SW can never
    // precache a stale shell served from heuristic HTTP caching.
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: "reload" })))),
  );
});

self.addEventListener("activate", (event) => {
  // Remove caches from old SW versions.
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin GET requests; let everything else pass through
  // (WebSocket upgrades, cross-origin, POST/PUT, etc.).
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  // Skip service-worker script itself and API/relay paths.
  if (url.pathname === "/sw.js") return;

  // Navigation requests (HTML pages): network-first, offline → shell.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          // Cache a fresh copy of index.html.
          const clone = res.clone();
          caches.open(CACHE).then((cache) => cache.put(request, clone));
          return res;
        })
        .catch(() => caches.match("/index.html")),
    );
    return;
  }

  // Static assets: cache-first (hashed filenames never change).
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((res) => {
        // Only cache successful, opaque-safe responses for same-origin assets.
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then((cache) => cache.put(request, clone));
        }
        return res;
      });
    }),
  );
});

// ---------------------------------------------------------------------------
// Web Push
// ---------------------------------------------------------------------------

self.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: "Armada", body: event.data.text() };
  }

  const data = payload.data ?? {};
  const options = {
    body: payload.body ?? "",
    icon: payload.icon || "/favicon.png",
    badge: payload.badge || "/favicon.png",
    data,
    // Collapse repeated notifications for the same conversation; renotify so a
    // new message in an already-notified conversation still alerts.
    tag: data.tag || "armada-notification",
    renotify: true,
  };

  event.waitUntil(self.registration.showNotification(payload.title ?? "Armada", options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const target = event.notification.data?.url || "/";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        // Focus an existing Armada tab and route it to the conversation.
        for (const client of clientList) {
          if (new URL(client.url).origin === self.location.origin) {
            client.navigate(target);
            return client.focus();
          }
        }
        // Otherwise open a fresh window at the target.
        return self.clients.openWindow(target);
      }),
  );
});
