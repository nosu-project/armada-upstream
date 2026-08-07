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

// NIP-17 unwrap for the DM push path (below). A classic worker can't `import`,
// and WebCrypto has no secp256k1, so this is a separately-built bundle
// (vite.config.sw-crypto.ts → dist/sw-crypto.js) exposing self.ArmadaDmCrypto.
// Guarded: it's absent in the unit-test VM and in any build that didn't ship
// it, in which case DM push simply degrades to the generic wake-up. `typeof` is
// safe on the undeclared name in that VM.
try {
  if (typeof importScripts === "function") {
    importScripts(new URL("sw-crypto.js", self.location.href).href);
  }
} catch {
  // Bundle missing/unparseable — self.ArmadaDmCrypto stays undefined.
}

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
//    using the same `tag`. Encrypted scopes (dm/c2) can't be opened
//    here without bundled crypto, so they keep the generic wake-up.

const PLAINTEXT_SCOPES = new Set(["group", "group-mention"]);
const PUSH_STATE_CACHE = "armada-push-state-v1";
const PUSH_STATE_PREFIX = "/.armada-push-state/";
const BADGE_STATE_URL = new URL(`${PUSH_STATE_PREFIX}badge`, self.location.origin).href;
// The page-provided DM gating config: request policy, known-peer set, the
// viewer's pubkey, and (nsec logins only) the decrypt key. Written by
// swDmConfig.ts; read here per DM push. Must match that module's path.
const DM_CONFIG_URL = new URL(`${PUSH_STATE_PREFIX}dm-config`, self.location.origin).href;

/** Increment the Home-Screen badge without needing a live page. */
async function incrementAppBadge() {
  if (typeof self.navigator?.setAppBadge !== "function") return;
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    const stored = await cache.match(BADGE_STATE_URL);
    const current = stored ? Number.parseInt(await stored.text(), 10) || 0 : 0;
    const next = Math.min(current + 1, 999);
    await Promise.all([
      cache.put(BADGE_STATE_URL, new Response(String(next))),
      self.navigator.setAppBadge(next),
    ]);
  } catch {
    // Badging is enhancement only; never risk the visible notification.
  }
}

/** Clear both the OS badge and the counter the next push increments. */
async function clearAppBadge() {
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    await cache.delete(BADGE_STATE_URL);
    if (typeof self.navigator?.clearAppBadge === "function") {
      await self.navigator.clearAppBadge();
    }
  } catch {
    // Ignore unsupported/revoked badging.
  }
}

/** Ask a live page whether it is focused with a specific DM thread open. */
function clientHasActiveDm(client) {
  if (typeof MessageChannel === "undefined" || typeof client.postMessage !== "function") {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const channel = new MessageChannel();
    let settled = false;
    const finish = (active) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.port1.close();
      resolve(active);
    };
    const timer = setTimeout(() => finish(false), 250);
    channel.port1.onmessage = (event) => finish(event.data?.active === true);
    try {
      client.postMessage({ type: "armada-active-dm-query" }, [channel.port2]);
    } catch {
      finish(false);
    }
  });
}

/** Whether this push references an event created by this browser install. */
async function isOwnPush(data) {
  if (!data.event_id) return false;
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    const ownUrl = new URL(
      `${PUSH_STATE_PREFIX}own/${encodeURIComponent(data.event_id)}`,
      self.location.origin,
    ).href;
    return Boolean(await cache.match(ownUrl));
  } catch {
    return false;
  }
}

/** Ask a live page whether its foreground notifier owns open-app alerts. */
function clientOwnsNotification(client) {
  if (typeof MessageChannel === "undefined" || typeof client.postMessage !== "function") {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const channel = new MessageChannel();
    let settled = false;
    const finish = (owns) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.port1.close();
      resolve(owns);
    };
    const timer = setTimeout(() => finish(false), 250);
    channel.port1.onmessage = (event) => finish(event.data?.owns === true);
    try {
      client.postMessage({ type: "armada-notification-owner-query" }, [channel.port2]);
    } catch {
      finish(false);
    }
  });
}

/** Whether this push is locally authored or owned by a live page. */
async function suppressPush(data) {
  if (await isOwnPush(data)) return true;
  if (!data.scope || !["dm", "group", "group-mention", "c2"].includes(data.scope)) {
    return false;
  }

  try {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });

    if (data.scope === "dm") {
      // An encrypted wrap hides its peer, so while any specific DM thread is in
      // the focused Armada window the page owns notification decisions. Ask the
      // page for its live React Router state: WindowClient.url is only the
      // document's creation URL and can still say `/dm` after pushState opened a
      // peer. The URL check remains as a fallback for directly-loaded threads or
      // browsers that cannot transfer a MessagePort.
      const liveStates = await Promise.all(windows.map((client) => clientHasActiveDm(client)));
      if (liveStates.some(Boolean)) return true;
      if (windows.some((client) => {
        try {
          const url = new URL(client.url);
          const parts = url.pathname.split("/").filter(Boolean);
          // `dms` is the pre-rename spelling: a window opened before this
          // worker updated still carries it in its creation URL, and missing
          // that is a duplicate notification for a thread being read.
          const dm = Math.max(parts.lastIndexOf("dm"), parts.lastIndexOf("dms"));
          return url.origin === self.location.origin
            && client.visibilityState === "visible"
            && client.focused
            && dm >= 0
            && parts.length > dm + 1;
        } catch {
          return false;
        }
      })) return true;
    }

    // A live page receives and resolves every watched plane through the wire.
    // Let its foreground notifier make the room-aware decision: it suppresses
    // the exact focused channel, but still shows an OS notification for another
    // channel or while Armada is hidden/unfocused. The worker remains the
    // fallback when no capable page is open.
    const owners = await Promise.all(windows.map((client) => clientOwnsNotification(client)));
    return owners.some(Boolean);
  } catch {
    return false;
  }
}

/**
 * The page-provided DM gating config, or null if none/unavailable. The blob is
 * AES-GCM sealed at rest under a non-extractable key; the crypto bundle opens it
 * (swSecretVault.openSealedConfig), so a config we can't decrypt — or a build
 * without the bundle — safely degrades to the generic wake-up.
 */
async function readDmConfig() {
  try {
    const crypto = self.ArmadaDmCrypto;
    if (!crypto || typeof crypto.openConfig !== "function") return null;
    const cache = await caches.open(PUSH_STATE_CACHE);
    const stored = await cache.match(DM_CONFIG_URL);
    if (!stored) return null;
    const sealed = new Uint8Array(await stored.arrayBuffer());
    return await crypto.openConfig(sealed);
  } catch {
    return null;
  }
}

/**
 * Show the notification for a NIP-17 DM push, deciding UP FRONT from the wrap
 * the server inlined (`data.event`) so we call showNotification exactly once,
 * within the mobile push window and with no relay fetch. Returns true when it
 * handled the push; false to fall back to the generic wake-up (no inlined wrap,
 * no bundled crypto, a login whose key the worker doesn't hold, or an
 * undecryptable/foreign/expired wrap).
 *
 * iOS revokes the whole push subscription after a few pushes that show nothing,
 * so every branch shows SOMETHING: `off` for an unknown sender is the quietest
 * we can be (one collapsing entry, no sound, no re-alert), never true silence.
 */
async function showDmNotification(base, data) {
  const wrap = data.event;
  const crypto = self.ArmadaDmCrypto;
  if (!wrap || !crypto) return false;
  const cfg = await readDmConfig();
  if (!cfg || !cfg.sk) return false; // non-nsec login → the worker can't decrypt
  const opened = crypto.unwrapDm(wrap, cfg.sk, cfg.self);
  if (!opened) return false; // undecryptable / not for us / expired

  // Drop the (large) inlined event from the data we attach to the notification.
  const routeData = { ...data };
  delete routeData.event;

  // Reactions/deletes/timer changes aren't messages, but the push must still
  // show something on iOS — the content-blind request ping.
  if (opened.kind !== 14 && opened.kind !== 15) {
    return showQuietRequest(base);
  }

  const known = Array.isArray(cfg.knownPeers) && cfg.knownPeers.indexOf(opened.sender) !== -1;

  if (known || cfg.policy === "full") {
    const preview = opened.kind === 15
      ? "Sent a file"
      : (truncate(opened.content, 140) || "New direct message");
    // The page seals display names for known peers beside the peer set; a
    // sender without one (or a pre-names config) keeps the generic title.
    const name = (cfg.peerNames && cfg.peerNames[opened.sender]) || "";
    await self.registration.showNotification(name ? `${name} sent you a message` : "New message", {
      ...base,
      body: preview,
      // Per-peer tag: a conversation collapses into one entry, distinct
      // conversations stay distinct.
      tag: `dm-${opened.sender}`,
      data: { ...routeData, url: `/dm/${opened.sender}` },
    });
    return true;
  }

  // Unknown sender.
  if (cfg.policy === "off") return showQuietRequest(base);

  // policy === "generic": content-blind request ping (nothing the sender picks).
  await self.registration.showNotification("Message request", {
    ...base,
    body: "New message request",
    tag: "armada-dm-requests",
    data: { ...routeData, url: "/dm" },
  });
  return true;
}

/**
 * Whether this install's push endpoint is Apple's. iOS revokes a site's web
 * push after a few pushes that display nothing, so on Apple endpoints a
 * suppressed push must still show SOMETHING. Other push services don't
 * penalize silent handling, and a suppressed push (own sent message, focused
 * thread) staying invisible is the better UX there.
 */
async function isApplePushEndpoint() {
  try {
    const sub = await self.registration.pushManager.getSubscription();
    return Boolean(sub && new URL(sub.endpoint).hostname.endsWith("push.apple.com"));
  } catch {
    return false;
  }
}

/**
 * The quietest notification iOS lets us get away with for a DM we don't want to
 * surface (unknown sender under `off`, or a non-message rumor): one "Message
 * requests" entry that collapses all of them, never re-alerts, and reveals
 * nothing the sender controls.
 */
async function showQuietRequest(base) {
  await self.registration.showNotification("Message requests", {
    ...base,
    body: "You have new message requests",
    tag: "armada-dm-requests",
    renotify: false,
    silent: true,
    data: { url: "/dm" },
  });
  return true;
}

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
      if (await suppressPush(data)) {
        // A suppressed push displays nothing, which iOS counts toward
        // revoking the subscription — keep Apple installs alive with one
        // silent, collapsing, never-realerting entry.
        if (await isApplePushEndpoint()) {
          await self.registration.showNotification("Armada", {
            ...base,
            body: "Messages synced",
            tag: "armada-quiet-sync",
            renotify: false,
            silent: true,
            data: { url: data.url || "/" },
          });
        }
        return;
      }

      // DMs: decide from the wrap the server inlined and show exactly once (see
      // showDmNotification), so an unknown sender is gated BEFORE anything they
      // control reaches the screen and a known sender's message can be shown —
      // all without a relay fetch. Falls through to the generic wake-up below
      // when the worker can't decrypt (no inlined wrap, non-nsec login, etc.).
      if (data.scope === "dm") {
        if (await showDmNotification(base, data)) {
          await incrementAppBadge();
          return;
        }
      }

      // 1. Guaranteed visible notification, immediately.
      await self.registration.showNotification(title, {
        ...base,
        body: payload.body ?? "",
        data,
        tag,
      });
      await incrementAppBadge();

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
          url: h && relays[0] ? groupUrl(relays[0], h, ev.id) : data.url,
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

/**
 * Deep link to a message in a NIP-29 group, matching the SPA's chat routes
 * (`src/lib/routes.ts`) — including the relay route param. A worker can't
 * import the app's module, so this stays a hand-written mirror; the shapes it
 * has to agree with are `/s/:server/:groupId` and its `/m/:messageId` suffix.
 */
function groupUrl(relayUrl, groupId, eventId) {
  const param = encodeURIComponent(
    relayUrl.replace(/^wss?:\/\//i, (m) => (m.toLowerCase() === "ws://" ? "ws:" : "")),
  );
  const room = `/s/${param}/${encodeURIComponent(groupId)}`;
  return eventId ? `${room}/m/${encodeURIComponent(eventId)}` : room;
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
  // useNostrPush re-registers on the next visit.
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

self.addEventListener("message", (event) => {
  if (event.data?.type === "armada-clear-badge") {
    event.waitUntil(clearAppBadge());
  }
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const target = event.notification.data?.url || "/";

  event.waitUntil(Promise.all([
    clearAppBadge(),
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
  ]));
});
