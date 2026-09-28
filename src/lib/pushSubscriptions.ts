/**
 * Content-blind push subscription set: maps the native service's notification
 * inputs to NIP-PUSH filter registrations. The server matches raw
 * kinds/tags/authors and sends a wake-up; the service worker decrypts/renders.
 * NIP-29 by `#h` (mentions-only via `#p`), NIP-17 wraps to the user, friends-only
 * kind-4, Concord stream authors merged by relay set (per-user quota). Ids and
 * arrays are deterministic to avoid server churn. Pure: no browser objects.
 *
 * Every openable scope sets `inline_event` so the worker renders the real
 * event; the server drops it when the payload would exceed its ~3800-unit
 * web-push budget (hence lean `notification.data`), and static title/body remain
 * the fallback.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import type { PushPrefs } from "@/lib/pushPrefs";
import type { NostrFilter } from "@nostrify/types";
import type { ConcordSub } from "@/concord/lib/concordNotifications";

const KIND_GROUP_MESSAGE = 9;
const KIND_GROUP_REPLY = 1111;
const KIND_REACTION = 7;
const KIND_DM_NIP04 = 4;
const KIND_GIFT_WRAP = 1059;

/** How the service worker fetches and renders the referenced event. */
export type PushScope = "group" | "group-mention" | "dm" | "c2";

/** Routing hints carried in the push payload's `data` for the service worker. */
export interface PushNotifData {
  scope: PushScope;
  relays: string[];
  [key: string]: unknown;
}

/** One content-blind subscription: stable id, relays, raw filter, static notification + SW routing data. */
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

export interface PushSubscriptionInput {
  pubkey: string;
  /** Relay-scoped NIP-29 groups; a bare `h` id is never globally unique. */
  nip29Groups: Nip29PushGroup[];
  prefs: PushPrefs;
  dmRelays: string[];
  /** Follows: friends-only kind-4 DM authors. */
  dmFollows: string[];
  /** Explicit per-conversation DM levels, keyed by canonical conversation key. */
  dmLevels: Record<string, "all" | "mentions" | "nothing">;
  /** Watched Concord channels. `muted` ones are here only for the decrypt config and get NO gateway subscription. */
  concord: Array<ConcordSub & { muted?: boolean }>;
}

/**
 * Make an app-local id globally unique for nostr-push (ids are server-global):
 * owner + domain + installation, since registration is REPLACE and native builds
 * share the web origin. Readable id plus a 128-bit digest (ids cap at 64 chars).
 * Legacy web ids lacked installation; `pushRegistry.ts` handles that migration.
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
 * The subscription with a non-empty fallback body. On web the empty body is
 * replaced instantly; on iOS an unrewritten notification (event too large to
 * inline, or a NIP-46/07 login that can't decrypt) stays on the lock screen.
 * Not `{{content}}`: that is resolved server-side and would expose plaintext.
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

/** Build the subscription set; `[]` when there's nothing to watch. */
export function buildPushSubscriptions(input: PushSubscriptionInput): PushSubscriptionSpec[] {
  const { pubkey, prefs } = input;
  const specs: PushSubscriptionSpec[] = [];

  // A group id is only meaningful at its relay: keep each filter on exactly one
  // relay (parallel relay/group arrays watched their Cartesian product). The
  // relay digest keeps ids stable; old flat ids are listed for migration.
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

  // Replies/reactions have different kinds, so they can't overlap the kind-9 filters.
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
    // Stay relay-scoped even with one relay: reverting to the flat id would create
    // a new id at exact quota and abort later refreshes.
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

  const dmRelays = uniqSorted(input.dmRelays);
  const dmFollows = uniqSorted(input.dmFollows);

  // NIP-17 wrap authors are ephemeral, so watch every wrap to the user (as the
  // native service does); this also lets message requests wake push.
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

  // NIP-04 stays friends-only (its author is public, so strangers would be a spam
  // path). Exact 1:1 overrides win over the global setting; group keys contain a
  // comma and are never flattened into author trust. No `inline_event`: the worker
  // can't open NIP-04.
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

  // Muted Concord channels raise no gateway subscription.
  for (const spec of mergeByRelaySet(
    input.concord
      .filter((s) => !s.muted)
      .map((s) => ({ relays: s.relays, values: s.streams.map((st) => st.pk) })),
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

/** Merge subscriptions with identical relay sets (deduped, sorted) to stay under the per-user quota. */
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
