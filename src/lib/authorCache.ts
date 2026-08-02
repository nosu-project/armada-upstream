/**
 * The shared `['author', pubkey]` query-cache helpers, extracted from
 * `useAuthor` so the profile sync layer (`src/sync/profileSync.ts`) can seed
 * resolved kind-0 profiles into the cache without importing the hook module
 * (which imports the sync layer — a cycle otherwise).
 */
import { type NostrMetadata, NSchema as n } from '@nostrify/nostrify';

import type { QueryClient } from '@tanstack/react-query';

import { appEventStore } from '@/lib/db/mainEventStore';
import { perfMark } from '@/lib/perf';

import type { NostrRumor } from '@/lib/nostrRumor';

export type AuthorResult = { event?: NostrRumor; metadata?: NostrMetadata };

/** The TanStack Query key holding a pubkey's parsed kind-0 profile. */
export function authorQueryKey(pubkey: string): [string, string] {
  return ['author', pubkey];
}

/** Parse a kind-0 event into metadata + event, or return just the event on parse failure. */
export function parseAuthorEvent(event: NostrRumor): { event: NostrRumor; metadata?: NostrMetadata } {
  try {
    const metadata = n.json().pipe(n.metadata()).parse(event.content);
    return { metadata, event };
  } catch {
    return { event };
  }
}

/**
 * Write a kind-0 event into the shared `['author', pubkey]` cache, but only if
 * it's newer than whatever is already there. Kind 0 is replaceable, so a plain
 * `setQueryData` from a background path (profile sync, follow-profiles,
 * notifications) can clobber a fresher profile another path already resolved —
 * the profile then "flips" back to older metadata. Everyone seeding the author
 * cache must go through here so newest-wins holds cache-wide, mirroring the
 * store's replaceable semantics.
 */
export function seedAuthorCache(queryClient: QueryClient, pubkey: string, event: NostrRumor): void {
  const key = authorQueryKey(pubkey);
  const existing = queryClient.getQueryData<AuthorResult>(key);
  if (existing?.event && existing.event.created_at >= event.created_at) return;
  queryClient.setQueryData<AuthorResult>(key, parseAuthorEvent(event));
}

/**
 * Newest profiles pre-warmed at boot, at most. The store keeps one row per
 * author (kind 0 is replaceable), so this is a cap on authors, not versions.
 */
const PREWARM_LIMIT = 2000;

/**
 * Seed every cached kind-0 profile into the query cache in ONE bulk read,
 * issued at module load — before the boot's relay mirroring starts writing
 * into the `main` tenant and readwrite transactions begin starving reads.
 *
 * Without this, a profile paints only after its `useAuthor` mounts (which
 * can't happen before the message timeline itself paints) and its individual
 * per-pubkey store read survives the boot write storm — measured at 20+
 * seconds of queueing on a warm boot. After this, a mounting `useAuthor`
 * finds its data already in the cache and paints synchronously.
 */
export async function prewarmAuthorCache(queryClient: QueryClient): Promise<void> {
  try {
    const store = await appEventStore();
    const profiles = await store.query([{ kinds: [0], limit: PREWARM_LIMIT }]);
    for (const event of profiles) seedAuthorCache(queryClient, event.pubkey, event);
    perfMark('authors.prewarm', `${profiles.length} profile(s) seeded`);
  } catch {
    // Best-effort: a failed pre-warm just means the lazy per-pubkey reads
    // (and the profile sync topic) do the work as before.
  }
}
