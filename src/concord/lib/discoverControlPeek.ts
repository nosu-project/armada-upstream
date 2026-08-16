/**
 * Discover Control peek — background, in-memory fold of a listing's Control
 * Plane so cards can show channel count (and enrich last-active with public
 * chat stream authors) without joining.
 *
 * This is NOT a member sync: wraps are not written to ArmadaDB, stream-auth is
 * not registered, and peeks are serialized ({@link enqueueDiscoverControlPeek})
 * so a full Discover grid does not fan out N Control reads at once. Name/icon
 * on the card still come from the invite bundle preview; this path only adds
 * fold-derived structure (channels).
 */

import { foldControlState, openControlEditions } from "@/concord/lib/control";
import { controlGroupKey, hex32, type StreamKeyView } from "@/concord/lib/derive";
import type { InviteBundle } from "@/concord/lib/invite";
import { KIND_WRAP } from "@/concord/lib/kinds";
import { openPlaneWrapsChunked } from "@/concord/lib/planeSync";
import { getArmadaDB } from "@/lib/db/armadaDB";
import { normalizeRelayUrl } from "@/lib/platform";

import type { NostrFilter } from "@nostrify/nostrify";
import type { NostrEvent } from "nostr-tools";

/** One page — matches the member Control sweep's page size. */
const PEEK_PAGE = 500;
/** Per-relay cap so a flooded plane can't pin Discover open forever. */
const PEEK_MAX_WRAPS = 2_000;
const PEEK_TIMEOUT_MS = 12_000;

/**
 * Persisted Control peek per community — same shape as the Discover directory
 * / bundle-floor seeds: KV accelerates the next session's first paint, and the
 * live query still runs (seeded STALE into react-query) so a channel create
 * isn't stuck behind a forever cache.
 */
const CONTROL_PEEK_KV = "discover:control-peek:";

export interface DiscoverControlPeek {
  channelCount: number;
  /** Non-deleted public channel ids — for last-active stream probes. */
  publicChannelIdHexes: string[];
}

/** Warm-load a prior peek for `communityId`, if any. */
export async function readCachedControlPeek(
  communityId: string,
): Promise<DiscoverControlPeek | undefined> {
  try {
    const stored = await getArmadaDB().kv.get<DiscoverControlPeek>(CONTROL_PEEK_KV + communityId);
    if (
      !stored
      || typeof stored.channelCount !== "number"
      || !Array.isArray(stored.publicChannelIdHexes)
    ) {
      return undefined;
    }
    return stored;
  } catch {
    return undefined;
  }
}

/** Persist a successful peek for the next session (best-effort). */
export function writeCachedControlPeek(communityId: string, peek: DiscoverControlPeek): void {
  getArmadaDB()
    .kv.set(CONTROL_PEEK_KV + communityId, peek)
    .catch(() => undefined);
}

type PeekNostr = {
  relay: (url: string) => {
    query: (filters: NostrFilter[], opts?: { signal?: AbortSignal }) => Promise<NostrEvent[]>;
  };
};

/** Read view for the bundle's current Control address (split or legacy). */
export function controlViewFromBundle(bundle: InviteBundle): StreamKeyView | null {
  try {
    const root = hex32(bundle.community_root);
    const communityId = hex32(bundle.community_id);
    const read = controlGroupKey(root, communityId, bundle.root_epoch);
    if (typeof bundle.control_pk === "string" && /^[0-9a-f]{64}$/i.test(bundle.control_pk)) {
      return {
        pk: bundle.control_pk.toLowerCase(),
        get convKey() {
          return read.convKey;
        },
        restricted: true,
      };
    }
    return read;
  } catch {
    return null;
  }
}

/** Summarize a folded channel map into the peek payload. */
export function summarizeDiscoverChannels(
  channels: Iterable<{ channelIdHex: string; isPrivate: boolean; deleted: boolean }>,
): DiscoverControlPeek {
  let channelCount = 0;
  const publicChannelIdHexes: string[] = [];
  for (const c of channels) {
    if (c.deleted) continue;
    channelCount += 1;
    if (!c.isPrivate) publicChannelIdHexes.push(c.channelIdHex);
  }
  return { channelCount, publicChannelIdHexes };
}

/**
 * Serial peek queue: each Discover card enqueues its Control read so only one
 * runs at a time (cards still paint from the bundle immediately).
 */
let peekTail: Promise<unknown> = Promise.resolve();

export function enqueueDiscoverControlPeek<T>(fn: () => Promise<T>): Promise<T> {
  const run = peekTail.then(fn, fn);
  peekTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Test seam — reset the serial chain between suites. */
export function _resetDiscoverControlPeekQueueForTests(): void {
  peekTail = Promise.resolve();
}

/**
 * Fetch + decrypt + fold Control for one invite bundle. Best-effort: a miss or
 * a truncated plane still returns whatever channels the served editions
 * contain, so the card can paint something — but a read that did not reach the
 * end of every relay (a dropped REQ, or a flood past {@link PEEK_MAX_WRAPS})
 * is returned WITHOUT being cached, since an under-count that gets persisted
 * outlives the condition that caused it.
 */
export async function peekDiscoverControl(
  nostr: PeekNostr,
  bundle: InviteBundle,
  signal?: AbortSignal,
): Promise<DiscoverControlPeek | null> {
  const view = controlViewFromBundle(bundle);
  if (!view) return null;

  const relays = [
    ...new Set(
      (Array.isArray(bundle.relays) ? bundle.relays : [])
        .map(normalizeRelayUrl)
        .filter((u): u is string => !!u),
    ),
  ];
  if (relays.length === 0) return null;

  let communityId: Uint8Array;
  try {
    communityId = hex32(bundle.community_id);
  } catch {
    return null;
  }

  const timeout = AbortSignal.any(
    [AbortSignal.timeout(PEEK_TIMEOUT_MS), ...(signal ? [signal] : [])],
  );

  const read = await fetchControlWraps(nostr, relays, view.pk, timeout);
  if (read.wraps.length === 0) {
    // An empty plane and a relay that never answered look identical from here,
    // so report the empty shape but never persist it as this community's.
    return { channelCount: 0, publicChannelIdHexes: [] };
  }

  const opened = await openPlaneWrapsChunked(read.wraps, [view]);
  const editions = openControlEditions(opened);
  const folded = foldControlState(editions, communityId, bundle.owner);
  const peek = summarizeDiscoverChannels(folded.channels.values());
  // Only a COMPLETE read describes the community. A channel create lives in
  // exactly one edition, so a truncated plane under-counts — and caching that
  // would paint the wrong number from the warm seed in every later session,
  // long after the relay that timed out came back.
  if (read.complete) writeCachedControlPeek(bundle.community_id, peek);
  return peek;
}

interface ControlWrapRead {
  wraps: NostrEvent[];
  /** Every relay was paged to exhaustion — see {@link peekDiscoverControl}. */
  complete: boolean;
}

/**
 * Page each relay INDEPENDENTLY and merge by wrap id.
 *
 * One cursor across a merged group read loses editions: each relay applies the
 * page limit on its own, so the group's oldest event comes from whichever relay
 * reaches deepest, and advancing every relay to that floor skips the window a
 * shallower relay has not been asked for yet. `channelSync` keeps a cursor per
 * relay for the same reason.
 */
async function fetchControlWraps(
  nostr: PeekNostr,
  relays: string[],
  author: string,
  signal: AbortSignal,
): Promise<ControlWrapRead> {
  const reads = await Promise.allSettled(
    relays.map((url) => pageControlWraps(nostr, url, author, signal)),
  );
  const byId = new Map<string, NostrEvent>();
  let complete = true;
  for (const r of reads) {
    if (r.status !== "fulfilled") {
      complete = false;
      continue;
    }
    if (!r.value.complete) complete = false;
    for (const ev of r.value.wraps) byId.set(ev.id, ev);
  }
  return { wraps: [...byId.values()], complete };
}

/** Walk one relay's copy of the plane, newest first. */
async function pageControlWraps(
  nostr: PeekNostr,
  url: string,
  author: string,
  signal: AbortSignal,
): Promise<ControlWrapRead> {
  const wraps: NostrEvent[] = [];
  const seen = new Set<string>();
  let until: number | undefined;

  for (;;) {
    if (wraps.length >= PEEK_MAX_WRAPS) return { wraps, complete: false };
    const filter: NostrFilter = { kinds: [KIND_WRAP], authors: [author], limit: PEEK_PAGE };
    if (until !== undefined) filter.until = until;

    let page: NostrEvent[];
    try {
      page = await nostr.relay(url).query([filter], { signal });
    } catch {
      return { wraps, complete: false };
    }

    let fresh = 0;
    let oldest = Infinity;
    for (const ev of page) {
      if (ev.created_at < oldest) oldest = ev.created_at;
      if (seen.has(ev.id)) continue;
      seen.add(ev.id);
      wraps.push(ev);
      fresh += 1;
    }

    // A short page is the end of this relay's plane.
    if (page.length < PEEK_PAGE) return { wraps, complete: true };
    if (oldest === Infinity || oldest <= 0) return { wraps, complete: true };

    // `until` is INCLUSIVE, so consecutive pages overlap by one second on
    // purpose: the overlap steps over a same-second burst instead of skipping
    // it, and the id dedupe makes it free. Control editions arrive in bursts
    // (founding a community writes metadata plus every channel in one second),
    // which is exactly what an exclusive `oldest - 1` would drop.
    //
    // A page that is ALL duplicates means the burst is wider than one page and
    // there is no cursor that advances without stepping over the rest of it.
    // Stop and say so, rather than under-count in silence.
    if (fresh === 0) return { wraps, complete: false };
    until = oldest;
  }
}
