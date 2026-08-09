/**
 * What the flood detector decided, remembered across sessions.
 *
 * `floodClusters` is a pure derivation over the loaded batch, and that is its
 * refresh problem: the verdict depends on context — channel history, arrival
 * order, the wave around a message — that the next session does not reload. A
 * refresh opens the newest window, the flood fills it, and the wall the fold
 * collapsed yesterday renders as chat (the same blindness measured in
 * `queryChannelFirstSeen`, but for the verdict itself). So the VERDICT is
 * kept: once a message folded, it stays folded, however little of its context
 * the next session holds.
 *
 * This is the `c2snap:` shape (see rumorStore.ts): a fact that is genuinely
 * not in the rumor, stored in KV as ids per scope — never a tag injected into
 * the stored rumor, never a row beside it. One KV entry per (community,
 * channel) that ever saw a fold, `{rumorId: ms}`, behind a `KvPrefixCache` so
 * the fold paths can read it synchronously.
 *
 * Semantics worth stating:
 *
 * - **Merge-only.** A later fold with less context (a shallow badge-path
 *   batch) must not un-remember what a better-informed fold decided; writers
 *   only ever add. A superset of what the store still holds is fine — every
 *   reader uses this to filter rows it has in hand, exactly like the snapshot
 *   sets.
 * - **Still a display fold.** Remembered ids feed the same quarantine set the
 *   live rules do: a collapsed row, one click to expand, never a drop. The
 *   Banlist remains the only author-identity drop.
 * - **A false positive is remembered too.** The allowance policy accepts
 *   casualties; {@link QUARANTINE_RETENTION_MS} bounds how long one lasts, and
 *   {@link QUARANTINE_MAX_IDS} bounds what a sustained flood can pin in one KV
 *   value (newest kept — the old end is the part scrolled past anyway).
 */
import { KvPrefixCache } from "@/lib/db/kvCache";

/** How long a remembered verdict outlives its message's timestamp. */
export const QUARANTINE_RETENTION_MS = 30 * 24 * 3_600_000;
/** Most ids one channel's memory may hold; the newest win. */
export const QUARANTINE_MAX_IDS = 2000;

const cache = new KvPrefixCache<Record<string, number>>({ prefix: "c2quar:" });

const entryId = (communityIdHex: string, channelIdHex: string) =>
  `${communityIdHex}:${channelIdHex}`;

let revision = 0;
cache.subscribe(() => {
  revision++;
});

/**
 * Re-render when the memory changes — most importantly when the warm lands,
 * since a fold that ran before it read "nothing remembered". Kicks the warm,
 * so subscribing is what makes the memory exist for a session.
 */
export function subscribeQuarantineMemory(listener: () => void): () => void {
  void cache.ready();
  return cache.subscribe(listener);
}

/** Snapshot counter for `useSyncExternalStore`. */
export function quarantineMemoryRevision(): number {
  return revision;
}

/** Resolves once the memory is warm (tests, and anything that must not race it). */
export function quarantineMemoryReady(): Promise<void> {
  return cache.ready();
}

/** Set views memoized on the stored value's identity (folds re-run often). */
const setMemo = new WeakMap<Record<string, number>, Set<string>>();

/**
 * The rumor ids this channel remembers folding, or undefined when none are.
 * Synchronous, and empty before the warm lands — a flood renders for a frame
 * and folds when the warm arrives, never the reverse.
 */
export function recallQuarantined(
  communityIdHex: string,
  channelIdHex: string,
): ReadonlySet<string> | undefined {
  const value = cache.get(entryId(communityIdHex, channelIdHex));
  if (!value) return undefined;
  let ids = setMemo.get(value);
  if (!ids) setMemo.set(value, (ids = new Set(Object.keys(value))));
  return ids.size > 0 ? ids : undefined;
}

/**
 * Merge freshly-folded ids (with their message timestamps) into the channel's
 * memory. Waits for the warm first, so an early fold cannot overwrite what a
 * past session stored; concurrent writers within a tab are serialized by the
 * cache's synchronous map, and across tabs last-writer-wins costs at most a
 * re-detectable verdict — the same trade `noteControlSnapshot` documents.
 */
export async function rememberQuarantined(
  communityIdHex: string,
  channelIdHex: string,
  entries: Iterable<readonly [rumorId: string, ms: number]>,
): Promise<void> {
  if (!communityIdHex || !channelIdHex) return;
  await cache.ready();
  const id = entryId(communityIdHex, channelIdHex);
  const existing = cache.get(id);
  let next: Record<string, number> | undefined;
  for (const [rumorId, ms] of entries) {
    if (existing?.[rumorId] !== undefined) continue;
    next ??= { ...existing };
    next[rumorId] = ms;
  }
  if (!next) return;

  const cutoff = Date.now() - QUARANTINE_RETENTION_MS;
  let kept = Object.entries(next).filter(([, ms]) => ms >= cutoff);
  if (kept.length > QUARANTINE_MAX_IDS) {
    kept.sort((a, b) => b[1] - a[1]);
    kept = kept.slice(0, QUARANTINE_MAX_IDS);
  }
  if (kept.length === 0) {
    if (existing) cache.delete(id);
    return;
  }
  cache.set(id, Object.fromEntries(kept));
}
