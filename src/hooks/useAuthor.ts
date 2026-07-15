import { type NostrEvent, type NostrMetadata, NSchema as n } from '@nostrify/nostrify';
import { useNostr } from '@nostrify/react';
import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';

import { useCacheFirstSeed } from '@/hooks/useCacheFirstSeed';
import { useEventStore } from '@/hooks/useEventStore';

export type AuthorResult = { event?: NostrEvent; metadata?: NostrMetadata };

/** The TanStack Query key holding a pubkey's parsed kind-0 profile. */
export function authorQueryKey(pubkey: string): [string, string] {
  return ['author', pubkey];
}

/** Parse a kind-0 event into metadata + event, or return just the event on parse failure. */
export function parseAuthorEvent(event: NostrEvent): { event: NostrEvent; metadata?: NostrMetadata } {
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
 * `setQueryData` from a background query (follow-profiles, notifications) can
 * clobber a fresher profile another path already resolved — the profile then
 * "flips" back to older metadata. Everyone seeding the author cache must go
 * through here so newest-wins holds cache-wide, mirroring the store's
 * replaceable semantics and the `useCacheFirstSeed` guard.
 */
export function seedAuthorCache(queryClient: QueryClient, pubkey: string, event: NostrEvent): void {
  const key = authorQueryKey(pubkey);
  const existing = queryClient.getQueryData<AuthorResult>(key);
  if (existing?.event && existing.event.created_at >= event.created_at) return;
  queryClient.setQueryData<AuthorResult>(key, parseAuthorEvent(event));
}

export function useAuthor(pubkey: string | undefined) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const eventStore = useEventStore();

  // Seed the query from the local event store so a known profile renders
  // immediately, without waiting on the network. The network query below
  // stays authoritative and overwrites this when it resolves.
  useCacheFirstSeed<AuthorResult>({
    queryKey: pubkey ? ['author', pubkey] : undefined,
    filter: { kinds: [0], authors: pubkey ? [pubkey] : [] },
    toData: parseAuthorEvent,
    getEvent: (data) => data.event,
  });

  return useQuery<AuthorResult>({
    queryKey: ['author', pubkey ?? ''],
    queryFn: async ({ signal }) => {
      if (!pubkey) {
        return {};
      }

      const store = await eventStore;

      const [event] = await nostr.query(
        [{ kinds: [0], authors: [pubkey], limit: 1 }],
        { signal },
      );

      if (!event) {
        // Relay returned nothing — a kind-0 miss is almost always transient
        // (the relay didn't have it, or the query timed out). Never discard a
        // profile we already have: fall back to the locally cached event so a
        // name/avatar already on screen doesn't blank out.
        const existing = queryClient.getQueryData<AuthorResult>(['author', pubkey]);
        if (existing?.event) {
          return existing;
        }
        const [cached] = await store.query([{ kinds: [0], authors: [pubkey] }]);
        if (cached) {
          return parseAuthorEvent(cached);
        }
        return {};
      }

      // Persist the fresh event to the local store (fire-and-forget).
      void store.event(event);

      return parseAuthorEvent(event);
    },
    enabled: !!pubkey,
    // A FOUND profile is cached long (5 min); a MISS is kept only briefly so a
    // profile that was cut off by the relay EOSE race (or simply hadn't synced
    // yet) is re-checked soon instead of staying blank for 5 minutes. Authors
    // with no kind 0 at all just re-check cheaply (batched) on the next access
    // and keep showing their fallback — no spinner, no tight retry loop.
    staleTime: (query) => (query.state.data?.event ? 5 * 60 * 1000 : 30 * 1000),
    gcTime: 10 * 60 * 1000,
    // While a profile is missing AND the component is mounted, retry in the
    // background at a relaxed cadence so it fills in without a manual reload.
    // Found profiles never poll. Bounded + batched, so a profileless author is
    // a cheap periodic no-op, not a hammer.
    refetchInterval: (query) => (query.state.data?.event ? false : 60 * 1000),
    refetchOnWindowFocus: false,
    retry: 1,
  });
}
