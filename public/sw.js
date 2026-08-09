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

// The push runtime: opening an inlined event, storing it, and composing what to
// show. A classic worker can't `import`, WebCrypto has no secp256k1, and none of
// the app's store or presentation code is reachable here — so this is a
// separately-built bundle (vite.config.sw-runtime.ts → dist/sw-crypto.js, a name
// kept for installed workers) exposing self.ArmadaDmCrypto. Guarded: it's absent
// in the unit-test VM and in any build that didn't ship it, in which case push
// degrades to the gateway's static wake-up. `typeof` is safe on the undeclared
// name in that VM.
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
//    pushSubscriptions.ts), and — because every subscription this worker can
//    open asks for `inline_event` — usually the matched event itself in
//    `data.event`.
//
// When the event is there, the runtime bundle opens it, stores it and hands
// back a real notification: the sender's name and avatar, the room's title and
// image, the message text. The gateway's static `title`/`body` are only the
// FALLBACK, for a payload too big to carry its event (nostr-push drops it past
// ~3800 bytes), a scope whose keys this worker doesn't hold, or a build with no
// bundle. That fallback then keeps the old behavior: show the static wake-up
// immediately — synchronously, so the userVisibleOnly contract is never broken,
// since iOS revokes the subscription after a few silent pushes — and for
// plaintext group messages replace it in place with the message preview fetched
// from a relay, using the same `tag`.

const PLAINTEXT_SCOPES = new Set(["group", "group-mention"]);
const PUSH_STATE_CACHE = "armada-push-state-v1";
const PUSH_STATE_PREFIX = "/.armada-push-state/";
const BADGE_STATE_URL = new URL(`${PUSH_STATE_PREFIX}badge`, self.location.origin).href;
// The page-provided push config: the DM request policy, the known-peer set, the
// viewer's pubkey, (nsec logins only) the decrypt key, and the per-channel
// Concord stream keys. Written by swPushConfig.ts; read here per push. Must
// match that module's path — `dm-config` is the ON-DISK spelling from when the
// blob only carried DM state, kept so an existing install's config stays
// readable across the update.
const PUSH_CONFIG_URL = new URL(`${PUSH_STATE_PREFIX}dm-config`, self.location.origin).href;
// The user's push kill switch, written by swPushDisabled.ts BEFORE the disable
// path's best-effort network teardown and deleted when push is re-enabled.
// While it is set this worker displays nothing and tears down its own
// subscription — the page's unsubscribe/server-delete can fail or be cut off
// mid-way, and a gateway that never saw the delete keeps pushing forever at a
// device whose user said stop.
const PUSH_DISABLED_URL = new URL(`${PUSH_STATE_PREFIX}disabled`, self.location.origin).href;
// Event ids this install has already presented, so a replayed push can't
// re-alert for a message the user has seen. Bounded like the own-event set.
const SEEN_EVENT_PREFIX = `${PUSH_STATE_PREFIX}seen/`;
const MAX_SEEN_EVENTS = 256;
// Consecutive pushes that displayed nothing, for the Apple keep-alive below.
const QUIET_STATE_URL = new URL(`${PUSH_STATE_PREFIX}quiet`, self.location.origin).href;
// How many pushes may pass without displaying anything before an Apple
// endpoint gets a visible keep-alive. iOS tolerates a few silent pushes and
// revokes the subscription past that, so the budget is spent periodically —
// NOT on every suppressed push, which put a "Messages synced" banner on screen
// for every message the user sent (their own NIP-17 self-copy is a push).
const APPLE_SILENT_BUDGET = 3;

// Per-room interruption ceiling, the web-push mirror of the native service's
// ALERT_BURST_MAX (NotificationRelayService.java). A public channel is writable
// by anyone holding the invite, so a flood reaches every device's push; past
// this many ALERTING notifications for one collapse `tag` inside the window,
// further ones post SILENTLY — still shown (iOS counts a silent push, and the
// tray entry and its line count still update), they just stop making noise.
// Content-blind, exactly like native: nothing is classified, a flood simply
// stops buzzing. The worker is killed between pushes, so the window's alert
// timestamps live in the push-state cache, keyed by tag.
const ROOM_ALERT_PREFIX = `${PUSH_STATE_PREFIX}alert/`;
const ROOM_ALERT_MAX = 5;
const ROOM_ALERT_WINDOW_MS = 120_000;
// Cap the timestamps one tag re-serializes while a flood is live (native's
// ALERT_BURST_MAX_TRACKED). Only the count within the window matters; the extra
// headroom keeps a sustained flood's window full so it stays quiet until it
// genuinely stops, instead of the budget refilling mid-flood.
const ROOM_ALERT_MAX_TRACKED = 64;

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

/**
 * Whether this push's event has already been presented by this install,
 * recording it when it hasn't.
 *
 * The gateway watches relays on our behalf; whenever it restarts a REQ — a
 * relay reconnect, or the client re-registering the same subscription — the
 * relay replays its stored matches and each one arrives as a fresh push. With
 * `renotify: true` that re-alerts for messages the user already read, at
 * whatever period the restart happens on. Presentation is therefore idempotent
 * per event id; a replay falls through to the quiet keep-alive.
 */
async function seenBefore(data) {
  if (!data.event_id) return false;
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    const url = new URL(
      `${SEEN_EVENT_PREFIX}${encodeURIComponent(data.event_id)}`,
      self.location.origin,
    ).href;
    if (await cache.match(url)) return true;
    await cache.put(url, new Response("1"));
    try {
      // Cache.keys() preserves insertion order, so the oldest go first.
      const prefix = new URL(SEEN_EVENT_PREFIX, self.location.origin).href;
      const seen = (await cache.keys()).filter((request) => request.url.startsWith(prefix));
      if (seen.length > MAX_SEEN_EVENTS) {
        await Promise.all(
          seen.slice(0, seen.length - MAX_SEEN_EVENTS).map((request) => cache.delete(request)),
        );
      }
    } catch {
      // No enumeration — the ledger just grows slowly.
    }
  } catch {
    // Never trade a real notification for a bookkeeping failure.
  }
  return false;
}

/** Forget the silent-push budget: a visible notification replenishes it. */
async function resetQuietBudget() {
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    await cache.delete(QUIET_STATE_URL);
  } catch {
    // Ignore — the counter self-corrects on the next suppressed push.
  }
}

/**
 * Nothing to present for this push (locally authored, owned by a live page, or
 * an event already shown). Display the quiet keep-alive only when this
 * install's endpoint is Apple's AND the silent-push budget is nearly spent.
 */
async function quietSync(base, data) {
  if (!(await isApplePushEndpoint())) return;
  let due = true;
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    const stored = await cache.match(QUIET_STATE_URL);
    const count = (stored ? Number.parseInt(await stored.text(), 10) || 0 : 0) + 1;
    due = count >= APPLE_SILENT_BUDGET;
    await cache.put(QUIET_STATE_URL, new Response(String(due ? 0 : count)));
  } catch {
    // Can't count — err toward keeping the subscription alive.
  }
  if (!due) return;
  await self.registration.showNotification("Armada", {
    ...base,
    body: "Messages synced",
    tag: "armada-quiet-sync",
    renotify: false,
    silent: true,
    data: { url: data.url || "/" },
  });
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
 * The page-provided push config's SEALED bytes, or null if none.
 *
 * Sealed at rest under a non-extractable AES-GCM key; only the runtime bundle
 * can open it (swSecretVault), so it is handed over as ciphertext and a config
 * we can't decrypt — or a build without the bundle — safely degrades to the
 * generic wake-up.
 */
async function readSealedConfig() {
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    const stored = await cache.match(PUSH_CONFIG_URL);
    if (!stored) return undefined;
    return new Uint8Array(await stored.arrayBuffer());
  } catch {
    return undefined;
  }
}

/**
 * Show the notification for a push whose event the gateway inlined, deciding
 * everything UP FRONT so we call showNotification exactly once — within the
 * mobile push window and with no relay fetch.
 *
 * Returns "shown" when it presented one, "dropped" when the opened event turned
 * out to be one the user must not be told about, and false to fall back to the
 * generic wake-up (no inlined event, no bundle, a scope whose keys this worker
 * doesn't hold, or an undecryptable / foreign / expired envelope).
 *
 * The bundle also STORES what it opened before returning, so a message received
 * while no tab was open is simply there on the next open.
 *
 * iOS revokes the whole push subscription after a few pushes that show nothing,
 * so every branch shows SOMETHING: `quiet` (an unknown sender under the `off`
 * request policy) is the quietest we can be — one collapsing entry, no sound,
 * no re-alert — never true silence.
 */
async function showInlineNotification(base, data, silent) {
  const runtime = self.ArmadaDmCrypto;
  if (!data.event || !runtime || typeof runtime.preparePush !== "function") return false;

  let prepared;
  try {
    const cfg = await runtime.openConfig(await readSealedConfig());
    prepared = await runtime.preparePush(data, cfg);
  } catch {
    return false; // never trade the notification for a bundle failure
  }
  if (!prepared) return false;

  // The bundle opened it and says it shouldn't be seen at all — the user's own
  // message sent from another device, or a reaction to someone else's. Only
  // the decrypted rumor could have told us that, so the decision arrives here
  // rather than in suppressPush. Treated exactly like any other suppressed
  // push: nothing shown, but the Apple keep-alive still ticks.
  if (prepared.drop) {
    await quietSync(base, data);
    return "dropped";
  }

  // Drop the (large) inlined event from the data we attach to the notification.
  const routeData = { ...data };
  delete routeData.event;

  // A content-blind request ping must not accumulate the room's lines — the
  // whole point is that it reveals nothing the sender chose.
  const lines = prepared.accumulate
    ? await appendRoomLine(prepared.tag, prepared.line)
    : [prepared.line];
  const quiet = silent || prepared.quiet === true;

  await self.registration.showNotification(prepared.title, {
    ...base,
    ...(quiet ? { silent: true, renotify: false } : {}),
    icon: prepared.icon,
    badge: prepared.badge,
    body: lines.join("\n"),
    // Per-room tag: a conversation collapses into one entry, distinct
    // conversations stay distinct.
    tag: prepared.tag,
    ...(Number.isFinite(prepared.timestamp) && prepared.timestamp > 0
      ? { timestamp: prepared.timestamp }
      : {}),
    data: { ...routeData, url: prepared.url, lines: prepared.accumulate ? lines : undefined },
  });
  return "shown";
}

/**
 * The room's recent notification lines plus `line`, capped at 5 — the closest
 * Web Notifications get to the native MessagingStyle expansion. The previous
 * notification for `tag` carries its lines in `data`; replacing it with the
 * appended list keeps a busy conversation readable instead of showing only
 * the newest message. Browsers without notification introspection just get
 * the single line.
 */
async function appendRoomLine(tag, line) {
  let lines = [];
  try {
    if (typeof self.registration.getNotifications === "function") {
      const [prior] = await self.registration.getNotifications({ tag });
      const held = prior && prior.data && Array.isArray(prior.data.lines) ? prior.data.lines : [];
      lines = held.slice(-4);
    }
  } catch {
    // No introspection — single-line body.
  }
  lines.push(line);
  return lines;
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
 * Whether this room's notification must post SILENTLY — it has already ALERTED
 * {@link ROOM_ALERT_MAX} times for `tag` inside the window. Records every
 * attempt (alerting or not), like the native service, so a sustained flood
 * keeps its own window full and stays quiet until it actually stops. Call once
 * per push, before showing; a bookkeeping failure never silences a real alert.
 */
async function roomAlertSilent(tag) {
  if (!tag) return false;
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    const url = new URL(`${ROOM_ALERT_PREFIX}${encodeURIComponent(tag)}`, self.location.origin).href;
    const now = Date.now();
    const stored = await cache.match(url);
    let times = [];
    if (stored) {
      try {
        const parsed = JSON.parse(await stored.text());
        if (Array.isArray(parsed)) times = parsed;
      } catch {
        // Corrupt entry — treat as empty.
      }
    }
    times = times.filter((t) => typeof t === "number" && now - t <= ROOM_ALERT_WINDOW_MS);
    const silent = times.length >= ROOM_ALERT_MAX;
    times.push(now);
    if (times.length > ROOM_ALERT_MAX_TRACKED) times = times.slice(-ROOM_ALERT_MAX_TRACKED);
    await cache.put(url, new Response(JSON.stringify(times)));
    return silent;
  } catch {
    return false;
  }
}

/**
 * Whether the user has turned push off on this install. The page's disable
 * path unsubscribes and deletes the gateway registrations, but both are
 * best-effort over the network; this flag is the local truth the worker can
 * enforce without any page open.
 */
async function pushDisabled() {
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    return Boolean(await cache.match(PUSH_DISABLED_URL));
  } catch {
    return false;
  }
}

/**
 * Tear down this install's own subscription so disabled pushes stop at the
 * source: once the endpoint is gone the push service answers 410 and the
 * gateway drops the registration — no relay cooperation needed.
 */
async function dropOwnSubscription() {
  try {
    const sub = await self.registration.pushManager.getSubscription();
    if (sub) await sub.unsubscribe();
  } catch {
    // The next stray push retries.
  }
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
    // Single-colour on transparency: the platform keeps only this image's alpha
    // channel, so the full-colour favicon that used to sit here rendered as a
    // solid blob in the status bar.
    badge: payload.badge || "/badge-96.png",
    renotify: true,
  };

  event.waitUntil(
    (async () => {
      // The user turned push off. Show NOTHING — deliberately breaking the
      // userVisibleOnly contract, because its penalty (the browser revoking
      // the subscription) is the outcome wanted here — and re-attempt the
      // teardown, since this push arriving proves the subscription is still
      // alive.
      if (await pushDisabled()) {
        await dropOwnSubscription();
        return;
      }

      // A suppressed push, or one replaying an event already presented here,
      // displays nothing — which iOS counts toward revoking the subscription.
      // quietSync() spends the keep-alive only once the budget is nearly out.
      if (await suppressPush(data)) {
        await quietSync(base, data);
        return;
      }
      if (await seenBefore(data)) {
        await quietSync(base, data);
        return;
      }

      // Past this room's interruption ceiling the notification is still shown
      // (and still updates its count), it just stops making noise — the web
      // mirror of the native ALERT_BURST_MAX. Decided once and applied to both
      // the wake-up and its enriched replacement so a flood past the budget
      // never re-alerts on the same event's second show either.
      //
      // Keyed on the SUBSCRIPTION-level tag rather than the room, because the
      // room is only known once the event is open, and a rate limit that a
      // sender can dodge by opening a new room isn't one. The inline path
      // re-tags the notification per room afterwards.
      const silent = await roomAlertSilent(tag);
      const alertBase = silent ? { ...base, silent: true, renotify: false } : base;

      // Decide from the event the gateway inlined and show exactly once (see
      // showInlineNotification): the real sender, the real room, the real
      // message — and stored on the way through. An unknown DM sender is gated
      // BEFORE anything they control reaches the screen. Falls through to the
      // static wake-up below when the event isn't there or can't be opened.
      const inline = await showInlineNotification(base, data, silent);
      if (inline === "shown") {
        await Promise.all([incrementAppBadge(), resetQuietBudget()]);
        return;
      }
      // A dropped push displayed nothing, so it neither counts against the
      // badge nor replenishes the silent-push budget quietSync just spent.
      if (inline === "dropped") return;

      // 1. Guaranteed visible notification, immediately.
      await self.registration.showNotification(title, {
        ...alertBase,
        body: payload.body ?? "",
        data,
        tag,
      });
      await Promise.all([incrementAppBadge(), resetQuietBudget()]);

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
        ...alertBase,
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
      // While the user's kill switch is set, a rotation must not resurrect
      // push: drop whatever the browser minted instead of re-subscribing.
      if (await pushDisabled()) {
        try {
          if (event.newSubscription) await event.newSubscription.unsubscribe();
        } catch {
          // Already dead, or the push service is unreachable — either way no
          // page will re-register it while the flag stands.
        }
        return;
      }
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
