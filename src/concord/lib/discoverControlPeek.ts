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
/** Cap so a flooded plane can't pin Discover open forever. */
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
  group: (urls: string[]) => {
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
 * Fetch + decrypt + fold Control for one invite bundle. Best-effort: a miss
 * or truncated plane returns whatever channels the served editions contain
 * (may under-count on a flooded/uncompacted plane past {@link PEEK_MAX_WRAPS}).
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

  const wraps = await fetchControlWraps(nostr, relays, view.pk, timeout);
  if (wraps.length === 0) {
    return { channelCount: 0, publicChannelIdHexes: [] };
  }

  const opened = await openPlaneWrapsChunked(wraps, [view]);
  const editions = openControlEditions(opened);
  const folded = foldControlState(editions, communityId, bundle.owner);
  const peek = summarizeDiscoverChannels(folded.channels.values());
  writeCachedControlPeek(bundle.community_id, peek);
  return peek;
}

async function fetchControlWraps(
  nostr: PeekNostr,
  relays: string[],
  author: string,
  signal: AbortSignal,
): Promise<NostrEvent[]> {
  const byId = new Map<string, NostrEvent>();
  let until: number | undefined;
  while (byId.size < PEEK_MAX_WRAPS) {
    const filter: NostrFilter = {
      kinds: [KIND_WRAP],
      authors: [author],
      limit: Math.min(PEEK_PAGE, PEEK_MAX_WRAPS - byId.size),
    };
    if (until !== undefined) filter.until = until;
    let page: NostrEvent[];
    try {
      page = await nostr.group(relays).query([filter], { signal });
    } catch {
      break;
    }
    if (page.length === 0) break;
    let oldest = Infinity;
    for (const ev of page) {
      byId.set(ev.id, ev);
      if (ev.created_at < oldest) oldest = ev.created_at;
    }
    if (page.length < PEEK_PAGE || oldest === Infinity || oldest <= 0) break;
    until = oldest - 1;
  }
  return [...byId.values()];
}
