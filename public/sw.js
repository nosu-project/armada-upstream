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

// The stamp plugin only runs at build time, so a surviving placeholder means
// the Vite DEV server is serving this file. A caching SW is poison in dev:
// module URLs aren't immutable (`?v=`/`?t=` generations), so cache-first mixes
// pre-bundle generations across reloads (two React copies → "Cannot read
// properties of null (reading 'useState')"), and the offline shell fallback
// silently boots a stale app when the dev server is down instead of failing
// visibly. Dev therefore keeps ONLY the push handlers: no precache, no fetch
// interception, and activation takes over open tabs immediately and purges
// every shell cache, so a previously poisoned dev install heals itself on the
// next reload.
const DEV = BUILD === "__BUILD_STAMP__";

// App-shell assets to warm on install. Vite hashes JS/CSS so they stay
// cache-first once cached; index.html is the SPA entry point.
const PRECACHE = ["/", "/index.html", "/theme.js", "/favicon.svg", "/favicon.png", "/apple-touch-icon.png", "/logo-192.png", "/logo-512.png", "/maskable-192.png", "/maskable-512.png", "/manifest.json"];

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

self.addEventListener("install", (event) => {
  // Dev: nothing to precache, and the no-skipWaiting rationale below is about
  // keeping a page on one consistent BUILD — meaningless under the dev server,
  // where immediate takeover is what lets a poisoned install heal.
  if (DEV) {
    self.skipWaiting();
    return;
  }
  // Install the new shell into a fresh, version-scoped cache. Deliberately do
  // NOT skipWaiting(): a new SW hijacking an already-loaded tab (which has
  // parsed the OLD index.html and is dynamically importing OLD chunk hashes)
  // is exactly what produces a mismatched old-HTML + new-chunk boot. The new SW
  // waits until every tab on the old build has gone, then takes over on the
  // next navigation — so each page load stays on one consistent build. Web
  // Push still works: an activated (waiting) SW handles push events regardless.
  event.waitUntil(
    // cache: "reload" bypasses the HTTP cache so a freshly-updated SW can never
    // precache a stale shell served from heuristic HTTP caching.
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: "reload" })))),
  );
});

self.addEventListener("activate", (event) => {
  // Dev: purge EVERY shell cache (including this worker's own name — dev never
  // caches) and claim open tabs now, so the very next reload fetches everything
  // from the live dev server.
  if (DEV) {
    event.waitUntil(
      Promise.all([
        caches
          .keys()
          .then((keys) =>
            Promise.all(keys.filter((k) => k.startsWith("armada-shell-")).map((k) => caches.delete(k))),
          ),
        self.clients.claim(),
      ]),
    );
    return;
  }
  // This SW only activates once no client is controlled by the previous one, so
  // its assets are no longer needed and can be dropped. Do NOT claim() existing
  // clients — they finish their session on the build they loaded with.
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      ),
  );
});

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

self.addEventListener("fetch", (event) => {
  // Dev: fully transparent — the dev server (or its absence) is the truth.
  if (DEV) return;

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

  // Hashed build assets (/assets/*): cache-first (content-hashed → immutable).
  //
  // The SPA fallback in nginx returns 404 (not index.html) for a chunk hash
  // that no longer exists after a deploy, so a stale tab's dynamic import()
  // fails cleanly and the client's chunk-load-error recovery reloads to a
  // consistent build. Guard against ever caching or returning an HTML document
  // under an asset URL — doing so is what makes a mismatched-chunk boot look
  // like "useContext(...) is null": the browser would try to run HTML as a JS
  // module.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((res) => {
          const type = res.headers.get("Content-Type") || "";
          const isHtml = type.includes("text/html");
          // Only cache a genuine, non-HTML asset response.
          if (res.ok && !isHtml) {
            const clone = res.clone();
            caches.open(CACHE).then((cache) => cache.put(request, clone));
          }
          return res;
        });
      }),
    );
    return;
  }

  // Other same-origin static files (icons, manifest, theme.js — stable paths):
  // cache-first, populate on first fetch.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((res) => {
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
