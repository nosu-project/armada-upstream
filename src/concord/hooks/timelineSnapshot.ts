/**
 * The last painted window of a channel's timeline, persisted so a warm reload
 * paints before the key-derivation chain resolves (seeded from the route's
 * channel id on first render).
 *
 * - Seeded STALE, so the real store read still runs.
 * - Never overwrites a populated cache (re-checked after the KV await).
 * - Rows filtered to their claimed channel id.
 * - Moderation is applied live by `foldTimeline`, not baked in.
 *
 * No new at-rest exposure (rumors are already stored decrypted); purged on logout.
 * SCOPED BY VIEWER, load-bearing: this cache is read before any key proves
 * membership, so without the pubkey key another account could read it.
 */
import { encode, readFolded, writeFolded } from "@/lib/foldedCache";
import { perfMark } from "@/lib/perf";

import type { QueryClient } from "@tanstack/react-query";
import type { OpenedChat } from "@/concord/lib/chat";

const SNAP_WINDOW = 40;

function snapKey(viewerPubkey: string, channelIdHex: string): string {
  return `c2-timeline-snap:${viewerPubkey}:${channelIdHex}`;
}

const prewarmed = new Set<string>();
const lastWritten = new Map<string, string>();

/** Seed `queryKey` from the snapshot unless the cache has data. */
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
  // The real store read may have landed meanwhile; it wins.
  if ((queryClient.getQueryData<OpenedChat[]>(queryKey)?.length ?? 0) > 0) return;
  // Stale on arrival: a first frame, never an answer.
  queryClient.setQueryData<OpenedChat[]>(queryKey, own, { updatedAt: Date.now() - 60_000 });
  perfMark("snap.prewarm", `${channelIdHex.slice(0, 8)} seeded ${own.length} row(s)`);
}

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

export function _resetTimelineSnapshotForTests(): void {
  prewarmed.clear();
  lastWritten.clear();
}
