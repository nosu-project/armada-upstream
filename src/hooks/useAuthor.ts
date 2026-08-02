import { useNostr } from '@nostrify/react';
import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { useEventStore } from '@/hooks/useEventStore';
import { authorQueryKey, parseAuthorEvent, type AuthorResult } from '@/lib/authorCache';
import { demandProfiles } from '@/sync/profileSync';

// Re-exported for the existing import sites; the implementations moved to
// `lib/authorCache.ts` so the profile sync layer can use them too.
export { authorQueryKey, parseAuthorEvent, seedAuthorCache } from '@/lib/authorCache';
export type { AuthorResult } from '@/lib/authorCache';

type EventStore = ReturnType<typeof useEventStore>;

/**
 * The shared TanStack Query options for resolving a pubkey's kind-0 profile.
 * Extracted so both {@link useAuthor} (single) and batched resolvers
 * ({@link useQueries}) hit the exact same `['author', pubkey]` cache.
 *
 * STORE-FIRST: the query reads ArmadaDB only, so a known profile paints from
 * disk without a network round-trip on the path. The network side lives in
 * the `profiles` sync topic (`src/sync/profileSync.ts`) — callers declare
 * demand ({@link demandProfiles}), and resolved profiles land here through
 * `seedAuthorCache` (newest-wins), which is also why there is no polling: an
 * update is pushed into the cache, not pulled by staleness.
 */
export function authorQueryOptions(
  queryClient: QueryClient,
  eventStore: EventStore,
  pubkey: string | undefined,
) {
  return {
    queryKey: authorQueryKey(pubkey ?? ''),
    queryFn: async (): Promise<AuthorResult> => {
      if (!pubkey) {
        return {};
      }

      const store = await eventStore;
      const [cached] = await store.query([{ kinds: [0], authors: [pubkey] }]);

      // Never downgrade: the sync layer may have seeded a fresher profile
      // between this query starting and the (slower) store read landing.
      const existing = queryClient.getQueryData<AuthorResult>(authorQueryKey(pubkey));
      if (existing?.event && (!cached || existing.event.created_at >= cached.created_at)) {
        return existing;
      }
      return cached ? parseAuthorEvent(cached) : {};
    },
    enabled: !!pubkey,
    // The local store is the source of truth and pushes updates in via
    // `seedAuthorCache`; re-running this queryFn on staleness would only
    // re-read the same rows. `invalidateQueries(['author', pk])` still forces
    // a store re-read (profile edits use it).
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: false,
  };
}

export function useAuthor(pubkey: string | undefined) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const eventStore = useEventStore();

  // The network half: declare this pubkey to the profile sync topic for the
  // life of the mount. The scheduler batches all mounted demands into one
  // relay round and seeds the query cache when profiles resolve.
  useEffect(() => {
    if (!pubkey) return;
    return demandProfiles([pubkey], { nostr, queryClient });
  }, [pubkey, nostr, queryClient]);

  return useQuery<AuthorResult>(authorQueryOptions(queryClient, eventStore, pubkey));
}
