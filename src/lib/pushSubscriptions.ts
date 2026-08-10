/**
 * Content-blind push subscription set.
 *
 * Maps Armada's notification model (the same inputs the native background
 * service in `useNativeNotifications` watches) to a set of NIP-PUSH filter
 * registrations for the nostr-push server. The server matches raw
 * kinds/tags/authors and sends a static wake-up; it never sees plaintext. The
 * service worker fetches the referenced event and decrypts/renders it (see
 * `sw.js`).
 *
 * Design goals mirroring native:
 *   - NIP-29 groups by `#h`; "all messages" vs "mentions-only" split so a
 *     mentions-only group only wakes on messages that `#p`-tag the user.
 *   - NIP-17 DMs (kind 1059) addressed to the user, plus friends-only legacy
 *     kind-4 DMs scoped to the follow set.
 *   - Concord (kind-1059 stream authors), merged by relay set
 *     to keep the subscription count under the server's per-user quota.
 *   - deterministic subscription ids and sorted tag/author arrays, so an
 *     unrelated refetch that merely reorders doesn't churn the server.
 *
 * The builder is pure (no browser objects): it emits `PushSubscriptionSpec`s;
 * the caller merges in `domain` + the browser `push_subscription`.
 *
 * Every subscription the worker can OPEN sets `inline_event` (all but the
 * legacy NIP-04 one — see below), which asks the server to embed the matched
 * event in the push payload itself (see nostr-push). It started as a
 * NIP-17 necessity — a gift wrap's sender is hidden until it's unsealed, so the
 * request-vs-known decision can only be made client-side — but it is what makes
 * every scope presentable: the worker renders the real message from the real
 * event rather than showing "New message" and then racing a relay for the text.
 * The server's static `title`/`body` below stay as the fallback for when it
 * doesn't arrive.
 *
 * It is best-effort by design and can never fail a delivery. nostr-push drops
 * the inlined event if the WHOLE payload would exceed its ~3800-unit web-push
 * budget, and the static wake-up (still carrying `event_id`) goes out instead —
 * so a long message degrades rather than disappearing. That budget is also why
 * `notification.data` stays lean here: every byte of routing hint is a byte the
 * event doesn't get.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import type { PushPrefs } from "@/lib/pushPrefs";
import type { NostrFilter } from "@nostrify/types";
import type { ConcordSub } from "@/concord/lib/concordNotifications";

// Kinds we key notifications off (all plaintext-or-encrypted matched by tag).
const KIND_GROUP_MESSAGE = 9;
const KIND_GROUP_REPLY = 1111;
const KIND_REACTION = 7;
const KIND_DM_NIP04 = 4;
const KIND_GIFT_WRAP = 1059;

/** How the service worker should fetch + render the referenced event. */
export type PushScope = "group" | "group-mention" | "dm" | "c2";

/** Routing hints carried in the push payload's `data` for the service worker. */
export interface PushNotifData {
  scope: PushScope;
  /** Relays the SW can fetch the event id from. */
  relays: string[];
  /** Opaque, JSON-serialised to the wire alongside the server's own fields. */
  [key: string]: unknown;
}

/**
 * One content-blind subscription: a stable id, the relays the server should
 * watch, the raw filter, and the static notification (+ SW routing data).
 */
export interface PushSubscriptionSpec {
  id: string;
  relays: string[];
  filter: NostrFilter;
  notification: { title: string; body: string; data: PushNotifData };
}

/** Everything needed to compute the subscription set (mirrors native inputs). */
export interface PushSubscriptionInput {
  pubkey: string;
  /** NIP-29 group/server relays. */
  relayUrls: string[];
  /** Watched group ids (`h` tags); excludes groups muted to `nothing`. */
  groupIds: string[];
  /** Subset of `groupIds` at the `mentions` level. */
  mentionOnlyGroupIds: string[];
  prefs: PushPrefs;
  /** Relays DMs are read from. */
  dmRelays: string[];
  /** Follows — friends-only kind-4 DM authors. */
  dmFollows: string[];
  concord: ConcordSub[];
}

/**
 * Convert an app-local subscription id into the globally unique id expected by
 * nostr-push. The server indexes subscriptions by `subscription_id` alone, so
 * a shared id such as `armada-groups` would otherwise be claimed by whichever
 * user registers it first. Include both owner and domain because the same
 * Nostr identity may use Armada from more than one web origin.
 *
 * `installation` adds a per-install dimension, and registering an id is
 * REPLACE — so any two installs that compute the same id take the gateway's one
 * record in turn, and whichever synced last is the only one still reachable.
 * The native builds pass one (`nativePush.ts`), because they share the public
 * web origin as their `domain` with the hosted client: without it, signing in
 * on the iPhone would silently overwrite the same account's browser
 * registrations, and the browser's next sync would overwrite the iPhone's back.
 *
 * The web path deliberately passes nothing, leaving its ids as they are: two
 * BROWSERS on one origin still collide the same way, but changing their ids
 * would make every existing install prune and re-register on next load, which
 * is a migration this doesn't need to carry.
 *
 * Keep the readable logical id for server logs and append a 128-bit digest;
 * nostr-push caps subscription ids at 64 characters.
 */
export function scopePushSubscriptionId(
  logicalId: string,
  pubkey: string,
  domain: string,
  installation?: string,
): string {
  const scope = [domain, pubkey, ...(installation ? [installation] : [])]
    .map((part) => part.toLowerCase())
    .join("\0");
  const tag = bytesToHex(sha256(new TextEncoder().encode(scope))).slice(0, 32);
  const prefix = logicalId.slice(0, 64 - tag.length - 1);
  return `${prefix}-${tag}`;
}

/**
 * Re-shape a spec's notification for a client that CANNOT open the event.
 *
 * Every spec above is written for the web service worker, which decrypts the
 * inlined event and rewrites the notification from it. Two things follow for a
 * client with no such stage — today, iOS, which has no Notification Service
 * Extension (`useIosPush.ts`), so what is registered is exactly what the lock
 * screen shows:
 *
 *  - **The body must stand alone.** The group scopes carry an empty body on
 *    purpose, since on the web it shows only for the instant before the real
 *    text replaces it. Registered as-is it would be an alert with a title and
 *    no body, the one outcome that reads as broken rather than as terse. This
 *    deliberately does NOT reach for NIP-PUSH's `{{content}}` template to do
 *    better: that is resolved server-side, which would route message text
 *    through a gateway whose entire point is that it never handles plaintext.
 *  - **`inline_event` and `relays` come off.** Both exist to feed a decrypt
 *    stage. With none, the event is payload the client cannot read and the
 *    relay list is for a fetch nobody makes — and on APNs they are spent
 *    against a hard 4096-byte budget. `scope` and `url` stay, because the tap
 *    handler routes on them.
 */
export function standaloneNotification(
  spec: PushSubscriptionSpec,
): { title: string; body: string; data: Record<string, unknown> } {
  const { title, body, data } = spec.notification;
  const { scope, url } = data as { scope: PushScope; url?: unknown };
  return {
    title,
    body: body || (scope === "group-mention"
      ? "Someone mentioned you"
      : "New message in a channel"),
    data: { scope, ...(typeof url === "string" ? { url } : {}) },
  };
}

/** Short deterministic tag from a relay set (for concord subscription ids). */
function relaySetTag(relays: string[]): string {
  const key = [...relays].sort().join(",");
  return bytesToHex(sha256(new TextEncoder().encode(key))).slice(0, 12);
}

function uniqSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * Build the content-blind subscription set. Returns `[]` when there's nothing
 * to watch (the caller then registers nothing / clears the server record).
 */
export function buildPushSubscriptions(input: PushSubscriptionInput): PushSubscriptionSpec[] {
  const { pubkey, prefs } = input;
  const specs: PushSubscriptionSpec[] = [];

  const relayUrls = uniqSorted(input.relayUrls);
  const watchedGroups = uniqSorted(input.groupIds);
  const mentionOnly = new Set(input.mentionOnlyGroupIds);
  const allGroups = watchedGroups.filter((id) => !mentionOnly.has(id));

  // Groups — every message (kind 9), for groups NOT restricted to mentions.
  if (prefs.allGroupMessages && allGroups.length > 0 && relayUrls.length > 0) {
    specs.push({
      id: "armada-groups",
      relays: relayUrls,
      filter: { kinds: [KIND_GROUP_MESSAGE], "#h": allGroups },
      notification: {
        title: "New message",
        body: "",
        data: { scope: "group", relays: relayUrls, inline_event: true },
      },
    });
  }

  // Groups — messages directed at the user (mentions/replies/reactions that
  // `#p`-tag them). Covers mentions-only groups AND is the only group path when
  // `allGroupMessages` is off. Kinds gated by the per-type prefs.
  const directedKinds = [
    ...(prefs.mentions ? [KIND_GROUP_MESSAGE] : []),
    ...(prefs.replies ? [KIND_GROUP_REPLY] : []),
    ...(prefs.reactions ? [KIND_REACTION] : []),
  ];
  if (directedKinds.length > 0 && watchedGroups.length > 0 && relayUrls.length > 0) {
    specs.push({
      id: "armada-groups-mention",
      relays: relayUrls,
      filter: { kinds: directedKinds, "#h": watchedGroups, "#p": [pubkey] },
      notification: {
        title: "New message",
        body: "",
        data: { scope: "group-mention", relays: relayUrls, inline_event: true },
      },
    });
  }

  // Direct messages — modern NIP-17 plus legacy NIP-04.
  const dmRelays = uniqSorted(input.dmRelays);
  const dmFollows = uniqSorted(input.dmFollows);

  // NIP-17 wrap authors are single-use ephemeral keys, so sender/follow
  // filtering is impossible until the client decrypts the wrap. Watch every
  // gift wrap addressed to the user, matching the wire and native notification
  // service. This is also what lets message requests wake web push.
  if (prefs.directMessages && dmRelays.length > 0) {
    specs.push({
      id: "armada-dm17",
      relays: dmRelays,
      filter: { kinds: [KIND_GIFT_WRAP], "#p": [pubkey] },
      notification: {
        title: "New message",
        body: "New direct message",
        data: { scope: "dm", relays: dmRelays, url: "/dm", inline_event: true },
      },
    });
  }

  // Legacy NIP-04 remains friends-only because its public author is available
  // to the content-blind push server and unknown senders would be a spam path.
  //
  // The ONE subscription that does not ask for `inline_event`: the worker
  // opens NIP-17 envelopes and Concord stream wraps, and a kind-4 ciphertext is
  // neither — it would arrive, fail to open, and fall back to this same static
  // wake-up, having spent payload budget to do it. Inline it if and when the
  // worker learns NIP-04.
  if (prefs.directMessages && dmFollows.length > 0 && dmRelays.length > 0) {
    specs.push({
      id: "armada-dm",
      relays: dmRelays,
      filter: { kinds: [KIND_DM_NIP04], "#p": [pubkey], authors: dmFollows },
      notification: {
        title: "New message",
        body: "New direct message",
        data: { scope: "dm", relays: dmRelays },
      },
    });
  }

  // Concord (kind-1059 stream authors), merged by relay set.
  for (const spec of mergeByRelaySet(
    input.concord.map((s) => ({ relays: s.relays, values: s.streams.map((st) => st.pk) })),
    "c2",
    (values, relays) => ({
      id: `armada-c2-${relaySetTag(relays)}`,
      relays,
      filter: { kinds: [KIND_GIFT_WRAP], authors: values },
      notification: {
        title: "New message",
        body: "New message in a community",
        data: { scope: "c2", relays, inline_event: true },
      },
    }),
  )) {
    specs.push(spec);
  }

  return specs;
}

/**
 * Collapse subscriptions that share an identical relay set into one filter
 * (dedup + sort the merged tag/author values). Keeps the subscription count
 * under the server's per-user quota. `scope` is only used to disambiguate the
 * (unused here) call sites; ids come from `make`.
 */
function mergeByRelaySet(
  items: Array<{ relays: string[]; values: string[] }>,
  _scope: PushScope,
  make: (values: string[], relays: string[]) => PushSubscriptionSpec,
): PushSubscriptionSpec[] {
  const byRelaySet = new Map<string, { relays: string[]; values: Set<string> }>();
  for (const item of items) {
    if (item.values.length === 0 || item.relays.length === 0) continue;
    const relays = uniqSorted(item.relays);
    const key = relays.join(",");
    const bucket = byRelaySet.get(key) ?? { relays, values: new Set<string>() };
    for (const v of item.values) bucket.values.add(v);
    byRelaySet.set(key, bucket);
  }
  return [...byRelaySet.values()]
    .map((b) => make([...b.values].sort(), b.relays))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
