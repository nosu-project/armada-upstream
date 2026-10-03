import { useNostr } from '@nostrify/react';
import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { useAvatarHeld } from '@/components/chat/mediaHold';

import { useEventStore } from '@/hooks/useEventStore';
import { authorQueryKey, parseAuthorEvent, type AuthorResult } from '@/lib/authorCache';
import { demandProfiles } from '@/sync/profileSync';

type EventStore = ReturnType<typeof useEventStore>;

/**
 * Shared query options for a pubkey's kind-0 (`['author', pubkey]`). STORE-FIRST:
 * reads ArmadaDB only; the network side is the `profiles` sync topic
 * (`src/sync/profileSync.ts`), which pushes updates via `seedAuthorCache` — hence
 * no polling.
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

      // Never downgrade: sync may have seeded a fresher profile meanwhile.
      const existing = queryClient.getQueryData<AuthorResult>(authorQueryKey(pubkey));
      if (existing?.event && (!cached || existing.event.created_at >= cached.created_at)) {
        return existing;
      }
      return cached ? parseAuthorEvent(cached) : {};
    },
    enabled: !!pubkey,
    // Updates are pushed via `seedAuthorCache`; invalidation still forces a re-read.
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: false,
  };
}

/** A held author's profile without its images; module-level so `select` stays memoized. */
function withoutImages(result: AuthorResult): AuthorResult {
  if (!result.metadata?.picture && !result.metadata?.banner) return result;
  const { picture: _picture, banner: _banner, ...metadata } = result.metadata;
  return { ...result, metadata, imagesWithheld: true };
}

/**
 * A pubkey's profile. Inside a media hold (`components/chat/mediaHold.ts`) an
 * author not yet trusted comes back without `picture`/`banner`, so every avatar
 * and banner falls back to initials without each call site knowing.
 */
export function useAuthor(pubkey: string | undefined) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const eventStore = useEventStore();

  // Declare demand to the profile sync topic for the life of the mount.
  useEffect(() => {
    if (!pubkey) return;
    return demandProfiles([pubkey], { nostr, queryClient });
  }, [pubkey, nostr, queryClient]);

  const held = useAvatarHeld(pubkey);
  return useQuery<AuthorResult>({
    ...authorQueryOptions(queryClient, eventStore, pubkey),
    ...(held ? { select: withoutImages } : {}),
  });
}
