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
 *   - friends-only DMs (kind 4) scoped to the follow set.
 *   - Concord V1 (`#z`) and V2 (kind-1059 stream authors), merged by relay set
 *     to keep the subscription count under the server's per-user quota.
 *   - deterministic subscription ids and sorted tag/author arrays, so an
 *     unrelated refetch that merely reorders doesn't churn the server.
 *
 * The builder is pure (no browser objects): it emits `PushSubscriptionSpec`s;
 * the caller merges in `domain` + the browser `push_subscription`.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import type { PushPrefs } from "@/hooks/usePushNotifications";
import type { NostrFilter } from "@nostrify/types";
import type { ConcordSub } from "@/concord-v1/lib/concordNotifications";
import type { Concord2Sub } from "@/concord-v2/lib/concordNotifications2";

// Kinds we key notifications off (all plaintext-or-encrypted matched by tag).
const KIND_GROUP_MESSAGE = 9;
const KIND_GROUP_REPLY = 1111;
const KIND_REACTION = 7;
const KIND_DM_NIP04 = 4;
const KIND_GIFT_WRAP = 1059;
const KIND_CONCORD_V1 = 3300;

/** How the service worker should fetch + render the referenced event. */
export type PushScope = "group" | "group-mention" | "dm" | "c1" | "c2";

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
  concordV1: ConcordSub[];
  concordV2: Concord2Sub[];
}

/**
 * Convert an app-local subscription id into the globally unique id expected by
 * nostr-push. The server indexes subscriptions by `subscription_id` alone, so
 * a shared id such as `armada-groups` would otherwise be claimed by whichever
 * user registers it first. Include both owner and domain because the same
 * Nostr identity may use Armada from more than one web origin.
 *
 * Keep the readable logical id for server logs and append a 128-bit digest;
 * nostr-push caps subscription ids at 64 characters.
 */
export function scopePushSubscriptionId(
  logicalId: string,
  pubkey: string,
  domain: string,
): string {
  const scope = `${domain.toLowerCase()}\0${pubkey.toLowerCase()}`;
  const tag = bytesToHex(sha256(new TextEncoder().encode(scope))).slice(0, 32);
  const prefix = logicalId.slice(0, 64 - tag.length - 1);
  return `${prefix}-${tag}`;
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
        data: { scope: "group", relays: relayUrls },
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
        data: { scope: "group-mention", relays: relayUrls },
      },
    });
  }

  // Direct messages — NIP-04, friends-only (scoped to the follow set).
  const dmRelays = uniqSorted(input.dmRelays);
  const dmFollows = uniqSorted(input.dmFollows);
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

  // Concord V1 (#z pseudonyms), merged by relay set.
  for (const spec of mergeByRelaySet(
    input.concordV1.map((s) => ({ relays: s.relays, values: s.zs })),
    "c1",
    (values, relays) => ({
      id: `armada-c1-${relaySetTag(relays)}`,
      relays,
      filter: { kinds: [KIND_CONCORD_V1], "#z": values },
      notification: {
        title: "New message",
        body: "New message in a community",
        data: { scope: "c1", relays },
      },
    }),
  )) {
    specs.push(spec);
  }

  // Concord V2 (kind-1059 stream authors), merged by relay set.
  for (const spec of mergeByRelaySet(
    input.concordV2.map((s) => ({ relays: s.relays, values: s.streams.map((st) => st.pk) })),
    "c2",
    (values, relays) => ({
      id: `armada-c2-${relaySetTag(relays)}`,
      relays,
      filter: { kinds: [KIND_GIFT_WRAP], authors: values },
      notification: {
        title: "New message",
        body: "New message in a community",
        data: { scope: "c2", relays },
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
