/**
 * The last painted window of a NIP-17 conversation, persisted across reloads.
 *
 * The DM thread had no equivalent of the Concord timeline snapshot, so a
 * warm reload of a conversation whose entire history is on disk still opened on
 * a skeleton. The cause is different from Concord's — there is no key-derivation
 * chain here; `useDm17Thread`'s query is enabled on the first render, because
 * `self`, `peer` and NIP-44 support are all known synchronously — but the READ
 * is not free: `queryDm17Thread` awaits `migrateLegacyDms` (a full legacy drain
 * on the first read of a session) and then merges two 300-row filters, which on
 * Android crosses the Capacitor bridge as JSON text. The skeleton lasts exactly
 * that long, over data that never left the device.
 *
 * It mattered more than the NIP-17 half alone suggests: the DM view merges both
 * transports (`isLoading || dm17.isLoading` in useDmTransport), so the legacy
 * kind-4 path's own localStorage snapshot could not paint through this one's
 * absence — the skeleton showed even for conversations that had a snapshot.
 *
 * Same discipline as the Concord snapshot, and for the same reasons:
 *
 *  - Seeded STALE (`updatedAt` in the past), so the query still fetches on
 *    mount: the snapshot paints, the real store read heals behind it. It is a
 *    first frame, never an answer.
 *  - Never overwrites a populated cache, and re-checked after the KV await, so
 *    a real read that lands mid-prewarm wins.
 *  - Rows are filtered to the conversation they claim, so a corrupted snapshot
 *    can never paint one conversation's messages under another.
 *
 * Plus one rule the channel snapshot has no need of: **NIP-40 expiry is applied
 * on both sides of the round-trip.** A disappearing message must not come back
 * from a cache after its deadline — the store physically sweeps expired rumors
 * and `queryDm17Thread` filters them, so a snapshot that skipped the check
 * would be the one path that resurrects them. Expired rows are dropped at write
 * (they are already worthless) and again at read (a snapshot written before the
 * deadline is read after it).
 *
 * Trust note: these rumors are ALREADY persisted decrypted in the account's DM
 * store (see dm17Store), so this adds no new at-rest exposure, and it lives in
 * the same ArmadaDB KV, so logout purges it with everything else. Note this is
 * deliberately NOT the older localStorage snapshot the kind-4 path uses: that
 * store is outside ArmadaDB and outside its purge.
 */
import { readFolded, writeFolded, encode } from "@/lib/foldedCache";
import { dmConvKey, isExpired } from "@/lib/nip17/protocol";
import { perfMark } from "@/lib/perf";

import type { OpenedDm } from "@/lib/nip17/protocol";
import type { QueryClient } from "@tanstack/react-query";

/**
 * Newest rows kept per conversation — a viewport's worth, not history.
 *
 * Larger than the channel snapshot's 40 because a DM window is a MIX of kinds:
 * reactions, deletes and timer changes share it with chat/file rumors, and only
 * the latter become message rows. Truncating newest-first is safe for the
 * others — a reaction or a delete is always newer than what it targets, so the
 * fold never keeps a message whose delete was truncated away.
 */
const SNAP_WINDOW = 80;

/** Both sides of the key: one account's view of one conversation. */
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
  // Keyed by the query key rather than the conversation: the thread's key
  // carries the decrypt-consent state, so a consent change re-seeds the new key
  // instead of leaving it empty behind a one-shot guard.
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
  // Rows are re-checked against the conversation they claim, so a corrupted or
  // stale snapshot can never paint one conversation's messages under another.
  const own = snap.filter(
    (m) => dmConvKey(m.peers ?? []) === conversation && !isExpired(m.tags, now),
  );
  if (own.length === 0) return;
  // Re-check after the await: the real store read may have landed meanwhile,
  // and it must win.
  if ((queryClient.getQueryData<OpenedDm[]>(queryKey)?.length ?? 0) > 0) return;
  // Stale on arrival, so the query's mount still runs the store read and its
  // background inbox sync.
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
