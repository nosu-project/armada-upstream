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
  /** Older logical ids this exact watch supersedes (quota-safe migration). */
  replaces?: string[];
  relays: string[];
  filter: NostrFilter;
  notification: { title: string; body: string; data: PushNotifData };
}

/** One relay-scoped NIP-29 conversation and its already-resolved level. */
export interface Nip29PushGroup {
  relay: string;
  groupId: string;
  level: "all" | "mentions";
}

/** Everything needed to compute the subscription set (mirrors native inputs). */
export interface PushSubscriptionInput {
  pubkey: string;
  /** Relay-scoped NIP-29 groups; a bare `h` id is never globally unique. */
  nip29Groups: Nip29PushGroup[];
  prefs: PushPrefs;
  /** Relays DMs are read from. */
  dmRelays: string[];
  /** Follows — friends-only kind-4 DM authors. */
  dmFollows: string[];
  /** Explicit per-conversation DM levels, keyed by canonical conversation key. */
  dmLevels: Record<string, "all" | "mentions" | "nothing">;
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
 * Web and native callers both pass a stable installation id. Older web builds
 * omitted it, so their callers must register the new id before pruning the
 * legacy id; `pushRegistry.ts` carries that migration state.
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
 * The same subscription, with a body that can stand on its own.
 *
 * The group scopes register an EMPTY body on purpose: on the web it shows for
 * only the instant before the service worker replaces it with the decrypted
 * message. iOS has a decrypt stage too now — the Notification Service Extension
 * (`ios/App/NotificationService`) — so `inline_event` and `relays` ride through
 * unchanged and the extension does the same rewrite.
 *
 * What differs is the FALLBACK. On the web an un-rewritten notification is a
 * flash; on iOS it is what stays on the lock screen, and there are two ordinary
 * ways to get one: an event too large for the gateway to inline (APNs allows
 * 4096 bytes of payload, and inlining is best-effort by design), and a login
 * whose key never reaches the device (NIP-46/NIP-07), for which the extension
 * cannot decrypt anything at all. An alert with a title and no body is the one
 * outcome that reads as broken rather than as terse, so the body is filled.
 *
 * Deliberately NOT filled with NIP-PUSH's `{{content}}` template, which would
 * be the obvious way to do better: that is resolved SERVER-side, and would put
 * the message text into a payload built by a gateway whose entire point is that
 * it never handles plaintext.
 */
export function standaloneNotification(
  spec: PushSubscriptionSpec,
): { title: string; body: string; data: PushNotifData } {
  const { title, body, data } = spec.notification;
  return {
    title,
    body: body || (data.scope === "group-mention"
      ? "Someone mentioned you"
      : "New message in a channel"),
    data,
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

  // A group id is meaningful only at its relay. The former parallel arrays
  // (`relayUrls` + `groupIds`) made the gateway watch their Cartesian product:
  // joining `general` on relay A also subscribed to `general` on relay B, and
  // two same-named rooms with different exact levels collapsed into one. Keep
  // each filter on exactly one relay; the relay digest keeps logical ids stable
  // and distinct while the old flat ids are listed for quota-safe migration.
  const nip29ByRelay = new Map<
    string,
    { all: Set<string>; mentions: Set<string> }
  >();
  for (const item of input.nip29Groups) {
    if (!item.relay || !item.groupId) continue;
    const bucket = nip29ByRelay.get(item.relay) ?? {
      all: new Set<string>(),
      mentions: new Set<string>(),
    };
    bucket[item.level].add(item.groupId);
    nip29ByRelay.set(item.relay, bucket);
  }

  // Replies and reactions have different kinds, so they cannot overlap either
  // kind-9 filter. They apply to every non-muted channel on its exact relay.
  const directedKinds = [
    ...(prefs.replies ? [KIND_GROUP_REPLY] : []),
    ...(prefs.reactions ? [KIND_REACTION] : []),
  ];
  for (const [relay, bucket] of [...nip29ByRelay.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const relays = [relay];
    const tag = relaySetTag(relays);
    const allGroups = [...bucket.all].sort();
    const mentionOnly = [...bucket.mentions].filter((id) => !bucket.all.has(id)).sort();
    const watchedGroups = uniqSorted([...allGroups, ...mentionOnly]);
    // IDs remain relay-scoped even when this snapshot currently has only one
    // relay. Switching 2→1 must keep the surviving child's id, and a one-relay
    // level change must expose the old category as authoritative stale state
    // before its replacement PUT. Reverting to the flat base in either case
    // creates a new id at exact quota and aborts every later DM/Concord refresh.
    const logicalId = (base: string) => `${base}-${tag}`;
    const replaces = (base: string) => [base];

    if (allGroups.length > 0) {
      specs.push({
        id: logicalId("armada-groups"),
        replaces: replaces("armada-groups"),
        relays,
        filter: { kinds: [KIND_GROUP_MESSAGE], "#h": allGroups },
        notification: {
          title: "New message",
          body: "",
          data: { scope: "group", relays, inline_event: true },
        },
      });
    }

    if (mentionOnly.length > 0) {
      specs.push({
        id: logicalId("armada-groups-mention"),
        replaces: replaces("armada-groups-mention"),
        relays,
        filter: {
          kinds: [KIND_GROUP_MESSAGE],
          "#h": mentionOnly,
          "#p": [pubkey],
        },
        notification: {
          title: "New message",
          body: "",
          data: { scope: "group-mention", relays, inline_event: true },
        },
      });
    }

    if (directedKinds.length > 0 && watchedGroups.length > 0) {
      specs.push({
        id: logicalId("armada-groups-directed"),
        replaces: replaces("armada-groups-directed"),
        relays,
        filter: { kinds: directedKinds, "#h": watchedGroups, "#p": [pubkey] },
        notification: {
          title: "New message",
          body: "",
          data: { scope: "group-mention", relays, inline_event: true },
        },
      });
    }
  }

  // Direct messages — modern NIP-17 plus legacy NIP-04.
  const dmRelays = uniqSorted(input.dmRelays);
  const dmFollows = uniqSorted(input.dmFollows);

  // NIP-17 wrap authors are single-use ephemeral keys, so sender/follow
  // filtering is impossible until the client decrypts the wrap. Watch every
  // gift wrap addressed to the user, matching the wire and native notification
  // service. This is also what lets message requests wake web push.
  const hasExplicitDmWatch = Object.values(input.dmLevels)
    .some((level) => level !== "nothing");
  if ((prefs.directMessages || hasExplicitDmWatch) && dmRelays.length > 0) {
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
  // Exact 1:1 overrides still win over that global fallback: an explicit
  // `all`/`mentions` adds the peer while global DMs are off, and `nothing`
  // removes them while global DMs are on. Canonical group-DM participant sets
  // contain a comma and must never be flattened into unrelated author trust.
  //
  // The ONE subscription that does not ask for `inline_event`: the worker
  // opens NIP-17 envelopes and Concord stream wraps, and a kind-4 ciphertext is
  // neither — it would arrive, fail to open, and fall back to this same static
  // wake-up, having spent payload budget to do it. Inline it if and when the
  // worker learns NIP-04.
  const legacyDmAuthors = new Set(prefs.directMessages ? dmFollows : []);
  for (const [conversation, level] of Object.entries(input.dmLevels)) {
    if (!/^[0-9a-f]{64}$/.test(conversation)) continue;
    if (level === "nothing") legacyDmAuthors.delete(conversation);
    else legacyDmAuthors.add(conversation);
  }
  const legacyAuthors = [...legacyDmAuthors].sort();
  if (legacyAuthors.length > 0 && dmRelays.length > 0) {
    specs.push({
      id: "armada-dm",
      relays: dmRelays,
      filter: { kinds: [KIND_DM_NIP04], "#p": [pubkey], authors: legacyAuthors },
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
