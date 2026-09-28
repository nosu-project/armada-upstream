/**
 * Background notifications as `NappSubscription`s — the one shape both of
 * Armada's closed-app push paths speak.
 *
 * There are two ways to be woken while Armada is closed in a browser-like
 * runtime, and they differ ONLY in how the subscriptions are handed over:
 *
 *   - Inside Tenna, Armada is an nsite and `window.napp.push` exists
 *     (tenna/NAPP.md). `set()` goes to the host, which holds the relays itself
 *     (Android) or hands the filters to a push service (iOS).
 *   - In a browser, the same list goes to a nostr-push2 gateway (`nostrPush2.ts`)
 *     together with a Web Push endpoint.
 *
 * Either way the service worker receives the same `napp.push.payload` in a
 * `push` event — the event itself, or its id and where to fetch it — and
 * `public/sw.js` presents it through one code path. Nothing here knows which
 * transport it is feeding beyond the limits it must pack into.
 *
 * The watch set itself is `buildPushSubscriptions` (`pushSubscriptions.ts`),
 * shared with the native paths; this module only reshapes it.
 */

import type { NostrEvent, NostrFilter } from "@nostrify/types";

import type { PushSubscriptionSpec } from "@/lib/pushSubscriptions";

/** Tenna's `NappSubscription`, which nostr-push2 also takes unchanged. */
export interface NappSubscription {
  filters: NostrFilter[];
  relays: string[];
}

/** `window.napp.push`, as Tenna defines it. */
export interface NappPush {
  /** Replace the site's subscriptions. An empty array clears them. */
  set(subscriptions: NappSubscription[]): Promise<void>;
  /** The subscriptions as stored, after normalization. */
  get(): Promise<NappSubscription[]>;
}

declare global {
  interface Window {
    readonly napp?: {
      readonly push?: NappPush;
    };
  }
}

/** Discriminator on every payload either transport delivers. */
export const NAPP_PUSH_PAYLOAD_TYPE = "napp.push.payload";

/** What `event.data.json()` returns in the worker, from either transport. */
export interface NappPushPayload {
  $type: typeof NAPP_PUSH_PAYLOAD_TYPE;
  event_id: string;
  /** Absent when the event did not fit the transport's ~4 KB budget. */
  event?: NostrEvent;
  /** Where the event came from, or where to look for it. */
  relays: string[];
}

export interface NappLimits {
  subscriptions: number;
  filters: number;
  relays: number;
  /** Longest list one filter may carry: ids, authors, kinds, tag values. */
  list: number;
}

/** Tenna's per-site ceilings. */
export const NAPP_LIMITS: NappLimits = { subscriptions: 10, filters: 10, relays: 10, list: 500 };

/** nostr-push2's per-client ceilings: Tenna's, with ten times the subscriptions. */
export const NOSTR_PUSH2_LIMITS: NappLimits = { ...NAPP_LIMITS, subscriptions: 100 };

/** The host's push API, when Armada is running as an nsite inside one. */
export function nappPushApi(): NappPush | undefined {
  if (typeof window === "undefined") return undefined;
  const push = window.napp?.push;
  return push && typeof push.set === "function" && typeof push.get === "function"
    ? push
    : undefined;
}

export function hasNappPush(): boolean {
  return nappPushApi() !== undefined;
}

/**
 * Whether a closed-app push path is live for this install, so the open page
 * must leave OS notifications to the service worker rather than show a second
 * one for the same event.
 */
export async function backgroundPushActive(
  registration: ServiceWorkerRegistration,
): Promise<boolean> {
  const napp = nappPushApi();
  if (napp) return (await napp.get()).length > 0;
  return Boolean(await registration.pushManager.getSubscription());
}

/** The independently-loading halves of the watch set. */
export type PushPlane = "groups" | "dm" | "concord";

/** Which plane a spec id belongs to (see `buildPushSubscriptions`). */
export function pushPlaneOf(id: string): PushPlane | undefined {
  if (id.startsWith("armada-groups")) return "groups";
  if (id.startsWith("armada-dm")) return "dm";
  if (id.startsWith("armada-c2")) return "concord";
  return undefined;
}

/** What survives of a spec once it has been handed over. */
export type PushWatch = Pick<PushSubscriptionSpec, "id" | "relays" | "filter">;

/**
 * The list to `set`, given a possibly incomplete snapshot.
 *
 * `set` REPLACES, so handing over a snapshot whose group list has not loaded
 * yet would silently unsubscribe every group. A plane that is not ready keeps
 * whatever was last handed over for it, alongside anything new; a ready plane
 * is exactly what the snapshot says. This is the prune rule the per-record
 * gateway enforced, restated for a transport that only takes whole lists.
 */
export function carryForwardWatches(
  current: PushWatch[],
  previous: PushWatch[],
  ready: Record<PushPlane, boolean>,
): PushWatch[] {
  const ids = new Set(current.map((watch) => watch.id));
  const carried = previous.filter((watch) => {
    const plane = pushPlaneOf(watch.id);
    return plane !== undefined && !ready[plane] && !ids.has(watch.id);
  });
  return [...current, ...carried];
}

/** Direct messages first: past the ceiling, the least personal plane goes. */
function planePriority(id: string): number {
  if (id === "armada-dm17") return 0;
  const plane = pushPlaneOf(id);
  if (plane === "dm") return 1;
  if (plane === "concord") return 2;
  return 3;
}

/** One filter per `max`-sized slice of every list longer than `max`. */
export function splitFilter(filter: NostrFilter, max: number): NostrFilter[] {
  for (const [key, value] of Object.entries(filter)) {
    if (!Array.isArray(value) || value.length <= max) continue;
    const out: NostrFilter[] = [];
    for (let i = 0; i < value.length; i += max) {
      out.push(...splitFilter({ ...filter, [key]: value.slice(i, i + max) }, max));
    }
    return out;
  }
  return [filter];
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Pack watches into subscriptions within `limits`.
 *
 * Watches on the same relay set share a subscription, since a subscription is
 * a set of filters on a set of relays; a relay set or filter list too long for
 * one is spread over several. Anything past the subscription ceiling is
 * dropped and counted, lowest priority first.
 */
export function toNappSubscriptions(
  watches: PushWatch[],
  limits: NappLimits,
): { subscriptions: NappSubscription[]; dropped: number } {
  const ordered = [...watches].sort((a, b) => planePriority(a.id) - planePriority(b.id));
  const byRelays = new Map<string, { relays: string[]; filters: NostrFilter[] }>();
  for (const watch of ordered) {
    const relays = [...new Set(watch.relays)].sort();
    if (relays.length === 0) continue;
    const key = relays.join(",");
    const bucket = byRelays.get(key) ?? { relays, filters: [] };
    bucket.filters.push(...splitFilter(watch.filter, limits.list));
    byRelays.set(key, bucket);
  }

  const subscriptions: NappSubscription[] = [];
  for (const { relays, filters } of byRelays.values()) {
    for (const relayChunk of chunk(relays, limits.relays)) {
      for (const filterChunk of chunk(filters, limits.filters)) {
        subscriptions.push({ filters: filterChunk, relays: relayChunk });
      }
    }
  }
  return {
    subscriptions: subscriptions.slice(0, limits.subscriptions),
    dropped: Math.max(0, subscriptions.length - limits.subscriptions),
  };
}

/** The last list handed over from this install, and whose it was. */
const LAST_SET_KEY = "armada:push-last-set:v1";

export function loadLastPushSet(pubkey: string): PushWatch[] {
  try {
    const raw = localStorage.getItem(LAST_SET_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { pubkey?: unknown; watches?: unknown };
    // Another account's watches are not this one's to carry forward.
    if (parsed?.pubkey !== pubkey || !Array.isArray(parsed.watches)) return [];
    return parsed.watches.filter((watch): watch is PushWatch =>
      typeof watch?.id === "string"
      && Array.isArray(watch.relays)
      && typeof watch.filter === "object"
      && watch.filter !== null);
  } catch {
    return [];
  }
}

export function saveLastPushSet(pubkey: string, watches: PushWatch[]): void {
  try {
    localStorage.setItem(LAST_SET_KEY, JSON.stringify({
      pubkey,
      watches: watches.map(({ id, relays, filter }) => ({ id, relays, filter })),
    }));
  } catch {
    // Without it a later partial snapshot carries nothing forward; it is still
    // correct for the planes that are ready.
  }
}

export function forgetLastPushSet(): void {
  try {
    localStorage.removeItem(LAST_SET_KEY);
  } catch {
    // ignore
  }
}
