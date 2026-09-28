import type { NostrFilter } from '@nostrify/nostrify';
import type { NostrRumor } from "@/lib/nostrRumor";
import { type QueryKey, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { useEventStore } from '@/hooks/useEventStore';

/** How recently a cache entry must have been written for the seed to skip its store read. */
const SEED_FRESH_MS = 60_000;

interface CacheFirstSeedOptions<T> {
  /** The query key to seed; `undefined` disables. */
  queryKey: QueryKey | undefined;
  /** Store filter used to read the cached event. The first match is used. */
  filter: NostrFilter;
  /** Map the cached event into the query's data shape. */
  toData: (event: NostrRumor) => T;
  /** Extract the event from existing data, so the seed never downgrades it. */
  getEvent: (data: T) => NostrRumor | undefined;
}

/**
 * Seed a TanStack Query from the local event store so cached data renders before
 * the network resolves. The owner's `useQuery` stays authoritative. Never
 * downgrades newer data already in the cache (also covers a slow store read).
 */
export function useCacheFirstSeed<T>(opts: CacheFirstSeedOptions<T>): void {
  const { queryKey, filter, toData, getEvent } = opts;
  const queryClient = useQueryClient();
  const eventStore = useEventStore();

  const queryKeyString = queryKey ? JSON.stringify(queryKey) : '';

  useEffect(() => {
    if (!queryKey) {
      return;
    }

    // Skip the store read if the entry was written moments ago (remount-heavy views).
    const updatedAt = queryClient.getQueryState(queryKey)?.dataUpdatedAt ?? 0;
    if (Date.now() - updatedAt < SEED_FRESH_MS) {
      return;
    }

    let cancelled = false;

    void (async () => {
      const store = await eventStore;
      const [cached] = await store.query([filter]);
      if (cancelled || !cached) {
        return;
      }
      const current = queryClient.getQueryData<T>(queryKey);
      const currentEvent = current ? getEvent(current) : undefined;
      if (currentEvent && currentEvent.created_at >= cached.created_at) {
        return;
      }
      queryClient.setQueryData<T>(queryKey, toData(cached));
    })();

    return () => {
      cancelled = true;
    };
    // `filter`/`toData`/`getEvent` are stable at call sites; the key is compared by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKeyString, eventStore, queryClient]);
}
