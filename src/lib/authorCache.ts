/**
 * The shared `['author', pubkey]` query-cache helpers, extracted from
 * `useAuthor` so the profile sync layer (`src/sync/profileSync.ts`) can seed
 * resolved kind-0 profiles into the cache without importing the hook module
 * (which imports the sync layer — a cycle otherwise).
 */
import { type NostrMetadata, NSchema as n } from '@nostrify/nostrify';

import type { QueryClient } from '@tanstack/react-query';

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
