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
// bundle. That path shows the static wake-up first to satisfy userVisibleOnly,
// then fetches by id and updates the SAME stable tag silently: plaintext and
// decryptable messages gain their preview without a second alert; a decrypted
// drop becomes a fixed, non-leaking sync entry on Apple (and is withdrawn on
// push services that allow true silence).

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
// One worker global handles concurrent PushEvents. Claim an event id before the
// first await so overlapping gateway filters cannot both race through the
// persistent Cache check and alert for the same event.
const IN_FLIGHT_EVENTS = new Map();

/**
 * Persistent/in-flight identity for one push match. NIP-29 event ids are not
 * globally one conversation: the same signed event can be stored on two
 * relays, and `h` is relay-local. Per-relay gateway specs make `relays[0]` the
 * exact source; include the inline event's `h` when available. Other planes
 * keep their ordinary event-id identity.
 */
function pushEventKey(data) {
  const eventId = typeof data?.event_id === "string" ? data.event_id : "";
  if (!eventId) return "";
  if (!PLAINTEXT_SCOPES.has(data.scope)) return eventId;
  const relays = Array.isArray(data.relays) ? data.relays : [];
  const relay = relays.length === 1 && typeof relays[0] === "string" ? relays[0] : "";
  if (!relay) return eventId;
  const h = data.event && typeof data.event === "object" ? tagValue(data.event, "h") : "";
  return `nip29|${relay}|${h || "?"}|${eventId}`;
}

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

/** Metadata for an event successfully handled by an earlier PushEvent. */
async function seenBefore(data) {
  const eventKey = pushEventKey(data);
  if (!eventKey) return undefined;
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    const url = new URL(
      `${SEEN_EVENT_PREFIX}${encodeURIComponent(eventKey)}`,
      self.location.origin,
    ).href;
    const stored = await cache.match(url);
    if (!stored) return undefined;
    try {
      const parsed = JSON.parse(await stored.text());
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // Legacy entries contained the literal "1".
    }
    return { outcome: "handled" };
  } catch {
    // Never trade a real notification for a bookkeeping failure.
    return undefined;
  }
}

/**
 * Commit an event only AFTER presentation or an exact page acknowledgement.
 * A worker killed between the old pre-show write and showNotification made the
 * event disappear forever on replay; the ledger must describe success, not an
 * attempt.
 */
async function markSeen(data, details = { outcome: "worker" }) {
  const eventKey = pushEventKey(data);
  if (!eventKey) return;
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    const url = new URL(
      `${SEEN_EVENT_PREFIX}${encodeURIComponent(eventKey)}`,
      self.location.origin,
    ).href;
    await cache.put(url, new Response(JSON.stringify(details)));
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
    // A bookkeeping failure may replay later; it must never hide this delivery.
  }
}

/**
 * Apple requires every PushEvent to produce a visible notification. A locally
 * authored event, replay, policy drop, or exact foreground-page acknowledgement
 * therefore updates one silent collapsed sync entry instead of going dark.
 * Returns whether it displayed one; other push services retain true silence.
 */
async function quietSync(tag = "armada-quiet-sync") {
  if (!(await isApplePushEndpoint())) return;
  await self.registration.showNotification("Armada", {
    // Deliberately fixed, not inherited from the gateway payload: suppression
    // covers own/replayed/policy-hidden events, so no sender-controlled title,
    // body, icon, route, or other message metadata may survive this fallback.
    icon: "/favicon.png",
    badge: "/badge-96.png",
    body: "Messages synced",
    tag,
    renotify: false,
    silent: true,
    data: { url: "/" },
  });
  return true;
}

const PAGE_PRESENTATION_OUTCOMES = new Set([
  "presenting",
  "presented",
  "suppressed",
  "unhandled",
  "worker",
]);

/** Ask or claim one exact opened event in a live page (room may be unresolved). */
function clientPresentationState(client, prepared, type, timeoutMs) {
  if (typeof MessageChannel === "undefined" || typeof client.postMessage !== "function") {
    return Promise.resolve({ outcome: "unhandled", roomKey: prepared.roomKey });
  }

  return new Promise((resolve) => {
    const channel = new MessageChannel();
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.port1.close();
      resolve(outcome);
    };
    const timer = setTimeout(
      () => finish({ outcome: "unhandled", roomKey: prepared.roomKey }),
      timeoutMs,
    );
    channel.port1.onmessage = (event) => {
      const reply = event.data;
      const replyRoom = typeof reply?.roomKey === "string" ? reply.roomKey : "";
      const roomMatches = prepared.roomKey
        ? replyRoom === prepared.roomKey
        : replyRoom !== "" || reply?.outcome === "worker" || reply?.outcome === "unhandled";
      finish(
        reply?.eventId === prepared.eventId
          && roomMatches
          && PAGE_PRESENTATION_OUTCOMES.has(reply?.outcome)
          ? { outcome: reply.outcome, roomKey: replyRoom || prepared.roomKey }
          : { outcome: "unhandled", roomKey: prepared.roomKey },
      );
    };
    try {
      client.postMessage({
        type,
        eventId: prepared.eventId,
        roomKey: prepared.roomKey,
      }, [channel.port2]);
    } catch {
      finish({ outcome: "unhandled", roomKey: prepared.roomKey });
    }
  });
}

function strongestPageOutcome(outcomes) {
  for (const outcome of ["presented", "presenting", "suppressed"]) {
    const match = outcomes.find((candidate) => candidate?.outcome === outcome);
    if (match) return match;
  }
  return undefined;
}

/**
 * Read a completed page outcome, then explicitly claim every unresolved page
 * before worker presentation. The claim response closes the query/claim race:
 * a page that presented in between reports that outcome; otherwise it records
 * worker ownership before acknowledging.
 */
async function pagePresentationOutcome(prepared) {
  if (!prepared?.eventId) return undefined;
  try {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (windows.length === 0) return undefined;
    const queried = await Promise.all(
      windows.map((client) => clientPresentationState(
        client,
        prepared,
        "armada-push-presentation-query",
        500,
      )),
    );
    const completed = strongestPageOutcome(queried);
    if (completed) return completed;

    const claimed = await Promise.all(
      windows.map((client) => clientPresentationState(
        client,
        prepared,
        "armada-push-worker-claim",
        650,
      )),
    );
    return strongestPageOutcome(claimed);
  } catch {
    return undefined;
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
 * Fail closed before the gateway's static fallback for an encrypted plane
 * whose page snapshot is explicitly incomplete. This check cannot wait for an
 * inlined/fetched event: legacy NIP-04 and oversized wraps reach the static
 * path first, where even a fixed "New message" would violate the plane gate.
 * Missing flags retain the behavior of configs written by older clients.
 */
async function pushPlaneUnready(data) {
  if (data.scope !== "dm" && data.scope !== "c2") return false;
  const runtime = self.ArmadaDmCrypto;
  if (!runtime || typeof runtime.openConfig !== "function") return false;
  try {
    const cfg = await runtime.openConfig(await readSealedConfig());
    return data.scope === "dm"
      ? cfg?.dmReady === false
      : cfg?.concordReady === false;
  } catch {
    return false;
  }
}

/** Open/store/resolve an inlined (or just-fetched) event without presenting it. */
async function prepareNotification(data) {
  const runtime = self.ArmadaDmCrypto;
  if (!data.event || !runtime || typeof runtime.preparePush !== "function") return undefined;
  try {
    const cfg = await runtime.openConfig(await readSealedConfig());
    return await runtime.preparePush(data, cfg);
  } catch {
    return undefined; // never trade the notification for a bundle failure
  }
}

/** Present one already-resolved notification. */
async function showPreparedNotification(base, data, prepared, options = {}) {
  // Drop the (large) inlined event from the data we attach to the notification.
  const routeData = { ...data };
  delete routeData.event;

  const displayTag = options.tag || prepared.tag;
  // A content-blind request ping must not accumulate the room's lines — the
  // whole point is that it reveals nothing the sender chose.
  const lines = prepared.accumulate
    ? options.reuseExisting
      ? (await existingRoomLines(displayTag)) ?? [prepared.line]
      : await appendRoomLine(displayTag, prepared.line)
    : [prepared.line];
  const quiet = options.silent === true || prepared.quiet === true;

  await self.registration.showNotification(prepared.title, {
    ...base,
    ...(quiet ? { silent: true, renotify: false } : {}),
    icon: prepared.icon,
    badge: prepared.badge,
    body: lines.join("\n"),
    tag: displayTag,
    ...(Number.isFinite(prepared.timestamp) && prepared.timestamp > 0
      ? { timestamp: prepared.timestamp }
      : {}),
    data: { ...routeData, url: prepared.url, lines: prepared.accumulate ? lines : undefined },
  });
}

/** Close every notification currently shown under `tag`. Best-effort. */
async function withdrawNotifications(tag) {
  try {
    if (typeof self.registration.getNotifications !== "function") return;
    const shown = await self.registration.getNotifications({ tag });
    for (const n of shown) n.close();
  } catch {
    // No introspection — the notification stays until tapped.
  }
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
  const lines = (await existingRoomLines(tag) ?? []).slice(-4);
  lines.push(line);
  return lines;
}

/** Lines already carried by the notification under this exact room tag. */
async function existingRoomLines(tag) {
  try {
    if (typeof self.registration.getNotifications === "function") {
      const [prior] = await self.registration.getNotifications({ tag });
      const held = prior && prior.data && Array.isArray(prior.data.lines) ? prior.data.lines : [];
      return held;
    }
  } catch {
    // No introspection — caller uses a single-line body.
  }
  return undefined;
}

/**
 * Whether this install's push endpoint is Apple's. WebKit requires every
 * PushEvent to display something, so a suppressed Apple push becomes a silent
 * collapsed sync entry. Other push services retain true suppression.
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

/** Handle one unique PushEvent. The caller serializes equal event ids. */
async function handlePush(payload, data, base) {
  // The user turned push off. Showing nothing is intentional here: dropping
  // the endpoint is the requested outcome, even if WebKit also revokes it.
  if (await pushDisabled()) {
    await dropOwnSubscription();
    return;
  }

  if (await pushPlaneUnready(data)) {
    await quietSync();
    await markSeen(data, { outcome: "suppressed" });
    return;
  }

  if (await isOwnPush(data)) {
    await quietSync();
    await markSeen(data, { outcome: "suppressed" });
    return;
  }
  const seen = await seenBefore(data);
  if (seen) {
    if (
      seen.outcome === "page-presented"
      && typeof seen.roomKey === "string"
      && await isApplePushEndpoint()
    ) {
      const replay = await prepareNotification(data);
      if (replay && !replay.drop && replay.roomKey === seen.roomKey) {
        await showPreparedNotification(base, data, replay, {
          tag: seen.roomKey,
          silent: true,
          reuseExisting: true,
        });
        return;
      }
    }
    await quietSync();
    return;
  }

  // Open/store first. Only a resolved event has an exact room/event identity a
  // page may acknowledge; generic capability or stale WindowClient URLs never
  // suppress a push again.
  const prepared = await prepareNotification(data);
  if (prepared) {
    if (prepared.drop) {
      await quietSync();
      await markSeen(data, { outcome: "suppressed" });
      return;
    }

    const pageOutcome = await pagePresentationOutcome(prepared);
    if (pageOutcome?.outcome === "presented" || pageOutcome?.outcome === "presenting") {
      const pageRoomKey = pageOutcome.roomKey || prepared.roomKey || prepared.tag;
      // A visible page already used this exact room tag. Apple still requires
      // a showNotification call for its PushEvent, so silently update that same
      // real entry (never add a generic banner or re-alert). A still-pending
      // page call gets the same update on every endpoint as a delivery fallback.
      if (pageOutcome.outcome === "presenting" || await isApplePushEndpoint()) {
        await showPreparedNotification(base, data, prepared, {
          tag: pageRoomKey,
          silent: true,
          reuseExisting: true,
        });
      }
      await markSeen(data, {
        outcome: "page-presented",
        roomKey: pageRoomKey,
      });
      return;
    }
    if (pageOutcome?.outcome === "suppressed") {
      // Active-room/read/policy suppression uses only the fixed non-leaking
      // Apple sync entry. Other push services may remain truly silent.
      await quietSync();
      await markSeen(data, { outcome: "suppressed" });
      return;
    }

    const silent = await roomAlertSilent(prepared.roomKey || prepared.tag);
    await showPreparedNotification(base, data, prepared, {
      tag: prepared.roomKey || prepared.tag,
      silent,
    });
    await Promise.all([incrementAppBadge(), markSeen(data)]);
    return;
  }

  // No key/event/runtime: show the gateway wake-up exactly once. Prefer an
  // event-stable tag so later enrichment can update this same entry without a
  // second alert; fall back to the subscription tag only when no event exists.
  const tag = pushEventKey(data) || data.tag || data.subscription_id || "armada-notification";
  const rateKey = data.tag || data.subscription_id || tag;
  const silent = await roomAlertSilent(rateKey);
  const alertBase = silent ? { ...base, silent: true, renotify: false } : base;
  const routeData = { ...data };
  delete routeData.event;
  await self.registration.showNotification(payload.title ?? "Armada", {
    ...alertBase,
    body: payload.body ?? "",
    data: routeData,
    tag,
  });
  await Promise.all([incrementAppBadge(), markSeen(data)]);

  // Best-effort enrichment is an UPDATE, never a second alert: keep the exact
  // static tag and force silent/non-renotify. This matters most for oversized
  // encrypted wraps, where the old room-tag replacement produced two banners.
  if (!data.event_id) return;
  const relays = Array.isArray(data.relays) ? data.relays : [];
  if (relays.length === 0) return;
  const canOpenEncrypted = (data.scope === "dm" || data.scope === "c2")
    && self.ArmadaDmCrypto
    && typeof self.ArmadaDmCrypto.preparePush === "function";
  if (!PLAINTEXT_SCOPES.has(data.scope) && !canOpenEncrypted) return;

  let ev;
  try {
    ev = await fetchEventFromRelays(relays, data.event_id, 4000);
  } catch {
    return; // leave the static notification in place
  }
  if (!ev) return;

  if (canOpenEncrypted) {
    const enriched = await prepareNotification({ ...data, event: ev });
    if (!enriched) return;
    if (enriched.drop) {
      if (await isApplePushEndpoint()) {
        await quietSync(tag);
      } else {
        await withdrawNotifications(tag);
      }
      return;
    }
    await showPreparedNotification(base, data, enriched, { tag, silent: true });
    return;
  }

  const h = tagValue(ev, "h");
  await self.registration.showNotification(payload.title ?? "Armada", {
    ...base,
    body: truncate(ev.content, 140) || payload.body || "",
    tag,
    silent: true,
    renotify: false,
    data: {
      ...routeData,
      url: h && relays[0] ? groupUrl(relays[0], h, ev.id) : data.url,
    },
  });
}

/** Serialize duplicate gateway matches without pre-committing the seen key. */
function runPush(payload, data, base) {
  const eventKey = pushEventKey(data);
  if (!eventKey) return handlePush(payload, data, base);

  const existing = IN_FLIGHT_EVENTS.get(eventKey);
  if (existing) {
    return (async () => {
      try {
        await existing;
      } catch {
        // The first show failed and therefore did not commit `seen`; this push
        // is the retry, not a duplicate to suppress.
        return handlePush(payload, data, base);
      }
      // Re-enter through the committed seen metadata. In particular, an Apple
      // event first presented by the page must silently update that same room
      // entry, not create a second generic sync notification.
      return handlePush(payload, data, base);
    })();
  }

  const current = handlePush(payload, data, base);
  const tracked = current.finally(() => {
    if (IN_FLIGHT_EVENTS.get(eventKey) === tracked) IN_FLIGHT_EVENTS.delete(eventKey);
  });
  IN_FLIGHT_EVENTS.set(eventKey, tracked);
  return tracked;
}

self.addEventListener("push", (event) => {
  let payload;
  if (!event.data) {
    payload = { title: "Armada", body: "Messages synced", data: {} };
  } else {
    try {
      payload = event.data.json();
    } catch {
      payload = { title: "Armada", body: event.data.text(), data: {} };
    }
  }

  const data = payload?.data ?? {};
  const base = {
    icon: payload?.icon || "/favicon.png",
    // Single-colour on transparency: the platform keeps only this image's alpha
    // channel, so the full-colour favicon that used to sit here rendered as a
    // solid blob in the status bar.
    badge: payload?.badge || "/badge-96.png",
    renotify: true,
  };
  event.waitUntil(runPush(payload ?? {}, data, base));
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

/** Keep notification routes inside this installed app's origin. */
function notificationTarget(raw) {
  try {
    const url = new URL(typeof raw === "string" ? raw : "/", self.location.origin);
    if (url.origin !== self.location.origin) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

/** Navigate before focusing; if either step fails, open the route explicitly. */
async function openNotificationTarget(target) {
  let fallbackClient;
  try {
    const clientList = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });
    fallbackClient = clientList.find((client) => {
      try {
        return new URL(client.url).origin === self.location.origin;
      } catch {
        return false;
      }
    });

    if (fallbackClient) {
      try {
        // `navigate()` is asynchronous. Focusing the old document before it
        // settles races the SPA's startup redirect and sometimes loses the
        // message route on iOS; await the returned WindowClient instead.
        const navigated = await fallbackClient.navigate(target);
        if (navigated && typeof navigated.focus === "function") {
          return await navigated.focus();
        }
      } catch {
        // A frozen/discarded client can reject navigation. Opening a new app
        // window is the reliable route-preserving fallback.
      }
    }
  } catch {
    // Client enumeration is best-effort; openWindow remains available.
  }

  try {
    const opened = await self.clients.openWindow(target);
    if (opened) return opened;
  } catch {
    // Last resort below: bring the existing client forward even if routing
    // could not be changed, rather than making the tap appear to do nothing.
  }
  if (fallbackClient && typeof fallbackClient.focus === "function") {
    return fallbackClient.focus();
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const target = notificationTarget(event.notification.data?.url);

  event.waitUntil(Promise.all([
    clearAppBadge(),
    openNotificationTarget(target),
  ]));
});
