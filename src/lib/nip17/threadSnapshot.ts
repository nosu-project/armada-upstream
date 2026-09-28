/**
 * The last painted window of a NIP-17 conversation, persisted in ArmadaDB KV so
 * a warm reload paints instantly instead of waiting on `queryDm17Thread`.
 * Same rules as the Concord timeline snapshot:
 *  - seeded STALE so the real read still runs and heals behind it;
 *  - never overwrites a populated cache (re-checked after the await);
 *  - rows filtered to the conversation they claim.
 * Plus: NIP-40 expiry is applied at write AND read, so disappearing messages
 * can't come back from cache. The rumors are already stored decrypted in
 * dm17Store, so no new at-rest exposure; purged on logout with the KV.
 */
import { readFolded, writeFolded, encode } from "@/lib/foldedCache";
import { dmConvKey, isExpired } from "@/lib/nip17/protocol";
import { perfMark } from "@/lib/perf";

import type { OpenedDm } from "@/lib/nip17/protocol";
import type { QueryClient } from "@tanstack/react-query";

/**
 * Newest rows kept per conversation. Larger than the channel snapshot's 40
 * because reactions/deletes/timers share the window; truncating newest-first
 * is safe since those are always newer than their targets.
 */
const SNAP_WINDOW = 80;

function snapKey(self: string, conversation: string): string {
  return `dm17-thread-snap:${self}:${conversation}`;
}

/** One prewarm attempt per query key per session; the write path keeps it fresh. */
const prewarmed = new Set<string>();
/** Last persisted content per conversation, so an identical window skips the write. */
const lastWritten = new Map<string, string>();

/**
 * Seed `queryKey` (the conversation's thread query) from the persisted
 * snapshot, unless the cache already has data. Fire-and-forget from an effect.
 */
export async function prewarmDm17ThreadSnapshot(
  queryClient: QueryClient,
  self: string,
  conversation: string,
  queryKey: readonly unknown[],
): Promise<void> {
  // Keyed by query key, which carries decrypt-consent state, so a consent change re-seeds.
  const once = JSON.stringify(queryKey);
  if (prewarmed.has(once)) return;
  prewarmed.add(once);
  if ((queryClient.getQueryData<OpenedDm[]>(queryKey)?.length ?? 0) > 0) return;
  const snap = await readFolded<OpenedDm[]>(snapKey(self, conversation));
  if (!snap || snap.length === 0) {
    perfMark("dm17.snap.prewarm", `${conversation.slice(0, 8)} miss`);
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  // Re-check rows against their conversation so a corrupted snapshot can't cross-paint.
  const own = snap.filter(
    (m) => dmConvKey(m.peers ?? []) === conversation && !isExpired(m.tags, now),
  );
  if (own.length === 0) return;
  // The real store read may have landed during the await; it wins.
  if ((queryClient.getQueryData<OpenedDm[]>(queryKey)?.length ?? 0) > 0) return;
  // Stale on arrival so the mount still runs the store read and inbox sync.
  queryClient.setQueryData<OpenedDm[]>(queryKey, own, { updatedAt: Date.now() - 60_000 });
  perfMark("dm17.snap.prewarm", `${conversation.slice(0, 8)} seeded ${own.length} row(s)`);
}

/** Persist the newest {@link SNAP_WINDOW} unexpired rows of `window`. */
export function persistDm17ThreadSnapshot(
  self: string,
  conversation: string,
  window: readonly OpenedDm[],
): Promise<void> {
  if (window.length === 0) return Promise.resolve();
  const now = Math.floor(Date.now() / 1000);
  const newest = window
    .filter((m) => !isExpired(m.tags, now))
    .sort((a, b) => b.createdAt - a.createdAt || (a.rumorId < b.rumorId ? -1 : 1))
    .slice(0, SNAP_WINDOW);
  if (newest.length === 0) return Promise.resolve();
  const id = snapKey(self, conversation);
  const serialized = encode(newest);
  if (lastWritten.get(id) === serialized) return Promise.resolve();
  const firstWrite = !lastWritten.has(id);
  lastWritten.set(id, serialized);
  if (firstWrite) perfMark("dm17.snap.persist", `${conversation.slice(0, 8)} ${newest.length} row(s)`);
  return writeFolded(id, newest);
}

/** Test seam: forget prewarm attempts and write memos. */
export function _resetDm17ThreadSnapshotForTests(): void {
  prewarmed.clear();
  lastWritten.clear();
}
