/**
 * The last painted window of a channel's timeline, persisted across reloads.
 *
 * Everything the timeline paints already survives a reload — the decrypted
 * rumors sit in the community tenant — but the PATH to them does not: a boot
 * re-derives the channel's stream keys (community list → control fold →
 * HKDF/secp derivations) before the timeline query is even enabled, so a warm
 * reload of a channel whose entire history is on disk still opened on a
 * skeleton for the length of that chain. This closes the same gap foldedCache
 * closes for the community list and the control fold, one level down: persist
 * the newest window of OPENED chat events per channel, and seed the
 * react-query cache from it the moment the channel id is known — which the URL
 * provides on the FIRST render, long before any key exists. The real store
 * read replaces it when the chain catches up.
 *
 * Rules that keep it honest:
 *
 *  - Seeded STALE (`updatedAt` in the past), so the query still fetches on
 *    mount: the snapshot paints, and the normal warm path (store read, park
 *    drain, backfill) heals behind it. The snapshot never suppresses a read.
 *  - Never overwrites a populated cache — same-session channel switches keep
 *    react-query's own, newer data — and re-checked after the KV await, so a
 *    real read that lands mid-prewarm wins.
 *  - Rows are filtered to the channel id they claim, so a corrupted snapshot
 *    can never paint one channel's messages under another.
 *  - Moderation is NOT baked in: the snapshot is the raw window, folded with
 *    live moderation by the same `foldTimeline` pass as real data.
 *
 * Trust note: the rumors are ALREADY persisted decrypted in the community
 * tenant (see rumorStore), so this snapshot adds no new at-rest exposure. It
 * lives in the same ArmadaDB KV, so logout purges it with everything else.
 *
 * SCOPED BY VIEWER, and that is load-bearing rather than tidy. Every other
 * Concord cache is reached through a resolved `Community`, which only
 * `useCommunityList` — filtered to the reader's own pubkey — can produce, so
 * membership gates them by construction. This one is deliberately reached from
 * the ROUTE's channel id on the first render, before any key exists, which is
 * exactly what makes it the one cache a second account on the device can read
 * without holding a single key: navigating to `/c/<id>/<channel>` was enough
 * to seed another account's decrypted messages into the query cache. Keying by
 * the reading pubkey means that prewarm looks up a key the account never wrote
 * and finds nothing. Pre-scoping rows are simply never read again.
 */
import { encode, readFolded, writeFolded } from "@/lib/foldedCache";
import { perfMark } from "@/lib/perf";

import type { QueryClient } from "@tanstack/react-query";
import type { OpenedChat } from "@/concord/lib/chat";

/** Newest rows kept per channel — a viewport's worth, not history. */
const SNAP_WINDOW = 40;

function snapKey(viewerPubkey: string, channelIdHex: string): string {
  return `c2-timeline-snap:${viewerPubkey}:${channelIdHex}`;
}

/** One prewarm attempt per channel per session; the write path keeps it fresh. */
const prewarmed = new Set<string>();
/** Last persisted content per channel, so an identical window skips the write. */
const lastWritten = new Map<string, string>();

/**
 * Seed `queryKey` (the channel's timeline query) from the persisted snapshot,
 * unless the cache already has data. Fire-and-forget from an effect.
 */
export async function prewarmTimelineSnapshot(
  queryClient: QueryClient,
  viewerPubkey: string,
  channelIdHex: string,
  queryKey: readonly unknown[],
): Promise<void> {
  const key = snapKey(viewerPubkey, channelIdHex);
  if (prewarmed.has(key)) return;
  prewarmed.add(key);
  if ((queryClient.getQueryData<OpenedChat[]>(queryKey)?.length ?? 0) > 0) return;
  const snap = await readFolded<OpenedChat[]>(key);
  if (!snap || snap.length === 0) {
    perfMark("snap.prewarm", `${channelIdHex.slice(0, 8)} miss`);
    return;
  }
  const own = snap.filter((m) => m.channelIdHex === channelIdHex);
  if (own.length === 0) return;
  // Re-check after the await: the real store read may have landed meanwhile,
  // and it must win.
  if ((queryClient.getQueryData<OpenedChat[]>(queryKey)?.length ?? 0) > 0) return;
  // Stale on arrival, so the query's mount still runs the store read and its
  // background catch-up — the snapshot is a first frame, never an answer.
  queryClient.setQueryData<OpenedChat[]>(queryKey, own, { updatedAt: Date.now() - 60_000 });
  perfMark("snap.prewarm", `${channelIdHex.slice(0, 8)} seeded ${own.length} row(s)`);
}

/** Persist the newest {@link SNAP_WINDOW} rows of `window` for `channelIdHex`. */
export function persistTimelineSnapshot(
  viewerPubkey: string,
  channelIdHex: string,
  window: OpenedChat[],
): Promise<void> {
  if (window.length === 0) return Promise.resolve();
  const key = snapKey(viewerPubkey, channelIdHex);
  const newest = [...window].sort((a, b) => b.ms - a.ms).slice(0, SNAP_WINDOW);
  const serialized = encode(newest);
  if (lastWritten.get(key) === serialized) return Promise.resolve();
  const firstWrite = !lastWritten.has(key);
  lastWritten.set(key, serialized);
  if (firstWrite) perfMark("snap.persist", `${channelIdHex.slice(0, 8)} ${newest.length} row(s)`);
  return writeFolded(key, newest);
}

/** Test seam: forget prewarm attempts and write memos. */
export function _resetTimelineSnapshotForTests(): void {
  prewarmed.clear();
  lastWritten.clear();
}
