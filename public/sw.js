/**
 * Armada Service Worker
 *
 * Push-only: receive Web Push notifications from the relay and route
 * notificationclick to the correct conversation. It deliberately does NOT
 * cache or intercept fetches.
 *
 * An earlier version of this worker also did app-shell caching (precached
 * index.html and served /assets/* cache-first). That made every release boot
 * into the error screen: a stale cached shell referencing old chunk hashes
 * survived even the client's one-time chunk-error recovery reload, on both the
 * hosted web app and inside the Capacitor WebView. HTTP caching of the build
 * (immutable hashed /assets/*, no-cache index.html — see nginx.conf) covers
 * fast loads without a second, self-managed cache layer that can go stale.
 */

// Replaced with the real build stamp by the armada-build-stamp Vite plugin, so
// every deploy changes this file's bytes and browsers install the update on
// the next navigation's sw.js re-check.
const BUILD = "__BUILD_STAMP__";
void BUILD;

self.addEventListener("install", () => {
  // Take over immediately: this worker holds no per-build state, so there is
  // no old-build/new-build consistency to preserve across a swap.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Purge every shell cache left behind by the old caching worker and claim
  // open clients, so installs that are stuck booting a stale cached shell heal
  // themselves as soon as this worker replaces the old one.
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
});

// ---------------------------------------------------------------------------
// Web Push
// ---------------------------------------------------------------------------

// The relay push payload: { title, body, icon, badge, data: { url, tag } }.

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

self.addEventListener("pushsubscriptionchange", (event) => {
  // The browser invalidated or rotated the push subscription (endpoint expiry,
  // push-service key rotation). Until a new subscription is registered with
  // the relay, every push goes to a dead endpoint. Resubscribe with the same
  // server key so a live subscription exists again, then tell open pages to
  // re-register it — the registration PUT needs a NIP-98 signature that only
  // the page's signer can produce. With no page open, the page-load sync in
  // usePushNotifications re-registers on the next visit.
  const key = event.oldSubscription?.options?.applicationServerKey;
  event.waitUntil(
    (async () => {
      if (!event.newSubscription && key) {
        try {
          await self.registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: key,
          });
        } catch {
          // Permission revoked or push service unreachable — nothing to do.
        }
      }
      const clientList = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of clientList) {
        client.postMessage({ type: "armada-push-changed" });
      }
    })(),
  );
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
