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

// Two payload sources land here:
//
//  - The legacy relay gateway sends a fully-rendered payload:
//    { title, body, icon, badge, data: { url, tag } } — shown as-is.
//
//  - The content-blind nostr-push gateway sends a static wake-up plus routing
//    hints: { title, body, data: { event_id, scope, relays } } (see
//    pushSubscriptions.ts). The server never sees plaintext; WE fetch the
//    referenced event and render it. We ALWAYS show the static notification
//    first (synchronously, so the userVisibleOnly contract is never broken —
//    iOS revokes the subscription after a few silent pushes), then, for
//    plaintext group messages, replace it in place with the message preview
//    using the same `tag`. Encrypted scopes (dm/dm17/c1/c2) can't be opened
//    here without bundled crypto, so they keep the generic wake-up.

const PLAINTEXT_SCOPES = new Set(["group", "group-mention"]);

self.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: "Armada", body: event.data.text() };
  }

  const data = payload.data ?? {};
  const tag = data.tag || data.subscription_id || data.event_id || "armada-notification";
  const title = payload.title ?? "Armada";
  const base = {
    icon: payload.icon || "/favicon.png",
    badge: payload.badge || "/favicon.png",
    renotify: true,
  };

  event.waitUntil(
    (async () => {
      // 1. Guaranteed visible notification, immediately.
      await self.registration.showNotification(title, {
        ...base,
        body: payload.body ?? "",
        data,
        tag,
      });

      // 2. Best-effort enrichment for plaintext events (nostr-push scopes).
      if (!data.event_id || !PLAINTEXT_SCOPES.has(data.scope)) return;
      const relays = Array.isArray(data.relays) ? data.relays : [];
      if (relays.length === 0) return;

      let ev;
      try {
        ev = await fetchEventFromRelays(relays, data.event_id, 4000);
      } catch {
        return; // leave the static notification in place
      }
      if (!ev) return;

      const h = tagValue(ev, "h");
      await self.registration.showNotification(title, {
        ...base,
        body: truncate(ev.content, 140) || payload.body || "",
        tag,
        data: {
          ...data,
          url: h && relays[0] ? groupUrl(relays[0], h) : data.url,
        },
      });
    })(),
  );
});

/** First value of the first `name` tag on an event, or undefined. */
function tagValue(event, name) {
  const t = (event.tags || []).find((x) => x[0] === name);
  return t ? t[1] : undefined;
}

function truncate(text, max) {
  if (typeof text !== "string") return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Deep link to a NIP-29 group, matching the SPA router's relay route param. */
function groupUrl(relayUrl, groupId) {
  const param = encodeURIComponent(
    relayUrl.replace(/^wss?:\/\//i, (m) => (m.toLowerCase() === "ws://" ? "ws:" : "")),
  );
  return `/s/${param}/${groupId}`;
}

/**
 * Fetch one event by id, racing the given relays, resolving with the first hit
 * (or undefined). Each socket is torn down on resolve or after `timeoutMs`.
 */
function fetchEventFromRelays(relays, id, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const sockets = [];
    const done = (ev) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const ws of sockets) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
      resolve(ev);
    };
    const timer = setTimeout(() => done(undefined), timeoutMs);

    for (const url of relays) {
      let ws;
      try {
        ws = new WebSocket(url);
      } catch {
        continue;
      }
      sockets.push(ws);
      const subId = `sw-${Math.random().toString(36).slice(2, 10)}`;
      ws.onopen = () => {
        try {
          ws.send(JSON.stringify(["REQ", subId, { ids: [id] }]));
        } catch {
          /* ignore */
        }
      };
      ws.onmessage = (msg) => {
        let frame;
        try {
          frame = JSON.parse(msg.data);
        } catch {
          return;
        }
        if (frame[0] === "EVENT" && frame[1] === subId && frame[2] && frame[2].id === id) {
          done(frame[2]);
        } else if (frame[0] === "EOSE" && frame[1] === subId) {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        }
      };
      ws.onerror = () => {
        /* other relays may still answer */
      };
    }

    if (relays.length === 0) done(undefined);
  });
}

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
