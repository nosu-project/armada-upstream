import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { useEventStore } from "@/hooks/useEventStore";
import { useRelayInfo } from "@/hooks/useRelayInfo";
import { useUserGroupList } from "@/hooks/useUserGroupList";
import {
  buildRelayGroups,
  KIND_GROUP_METADATA,
  relayGroupCacheFilters,
} from "@/lib/nip29";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

/**
 * Fetch all groups hosted on a server (relay).
 *
 * Group metadata events (kind 39000) MUST be signed by the relay's own key.
 * When the relay advertises that key via NIP-11 (`self` or `pubkey`), the
 * query filters by `authors` so forged metadata from other publishers is
 * never trusted.
 *
 * Relays may hide closed/private groups from open-ended listings, so the
 * ids remembered in the user's kind 10009 list are queried explicitly by
 * `d` tag and merged in.
 *
 * The channel list is one of the most STABLE things in the app: it's
 * relay-signed metadata that changes only when an admin creates/edits/deletes
 * a channel. So this query is deliberately quiet — no polling, a long
 * staleTime, an IndexedDB seed so it renders instantly on reload, and explicit
 * invalidation (see useGroupModeration / useCreateGroup) for the rare real
 * changes. The query KEY is just the relay URL: `relaySelf` and the remembered
 * ids are read inside the queryFn for filtering, but kept OUT of the key so a
 * resolving NIP-11 doc or a churning kind-10009 list can't swap the cache
 * entry and force a refetch from scratch.
 */
export function useRelayGroups(relayUrl: string | undefined) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const eventStore = useEventStore();
  const { data: relayInfo, isLoading: infoLoading, isError: infoError } = useRelayInfo(relayUrl);
  const { data: userList } = useUserGroupList();

  const relaySelf = relayInfo?.self || relayInfo?.pubkey;
  const rememberedIds = (userList?.groups ?? [])
    .filter((ref) => ref.relay === relayUrl)
    .map((ref) => ref.id)
    .sort();

  const queryKey = ["nip29", "groups", relayUrl];

  // Cache-first seed: hydrate the channel list from IndexedDB (where the relay's
  // kind-39000 metadata is persisted by NostrBatcher) so it renders instantly on
  // a fresh mount/reload instead of going blank while the relay round-trips.
  // Reads are scoped to THIS relay (see relayGroupCacheFilters) so one server's
  // channels never bleed into another's.
  useEffect(() => {
    if (!relayUrl) return;
    let cancelled = false;
    void (async () => {
      if (queryClient.getQueryData(queryKey)) return;
      const filters = relayGroupCacheFilters(relaySelf, rememberedIds);
      if (filters.length === 0) return;
      const store = await eventStore;
      const cached = await store.query(filters);
      if (cancelled || cached.length === 0) return;
      if (queryClient.getQueryData(queryKey)) return;
      queryClient.setQueryData(queryKey, buildRelayGroups(cached, relayUrl));
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relayUrl, relaySelf, rememberedIds.join(","), eventStore, queryClient]);

  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const authors = relaySelf ? { authors: [relaySelf] } : {};
      const filters: NostrFilter[] = [
        { kinds: [KIND_GROUP_METADATA], ...authors, limit: 500 },
      ];
      if (rememberedIds.length > 0) {
        filters.push({ kinds: [KIND_GROUP_METADATA], "#d": rememberedIds, ...authors });
      }

      const events = await nostr.relay(relayUrl!).query(filters, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      });

      // Merge with the relay's cached metadata so a sparse or empty relay read
      // never DROPS channels we already knew about (the disappearing-channels
      // bug). `buildRelayGroups` dedupes by id keeping the newest, so a relay
      // edit/delete still wins (newer created_at) and a real kind-5 delete has
      // already pruned the cache. Cache events go FIRST so the network result
      // supersedes ties — see buildRelayGroups for the full rationale.
      const cacheScoped = relayGroupCacheFilters(relaySelf, rememberedIds);
      let cached: NostrEvent[] = [];
      if (cacheScoped.length > 0) {
        const store = await eventStore;
        cached = await store.query(cacheScoped);
      }

      return buildRelayGroups([...cached, ...events], relayUrl!);
    },
    enabled: Boolean(relayUrl) && !infoLoading,
    // Relay-signed, rarely-changing data. Keep it fresh for the whole session
    // and rely on explicit invalidation for the rare real change.
    staleTime: 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    refetchOnMount: false,
    refetchOnReconnect: false,
  });

  // The remembered ids (private/closed channels from the kind-10009 list) are
  // not part of the query key — that list churns constantly and we don't want it
  // swapping the cache entry. But if the user joins a channel the open listing
  // hides, its id won't be in the current result; refetch ONCE in that case so
  // the newly-joined channel shows up. Steady state (every remembered id already
  // present) stays quiet.
  const data = query.data;
  useEffect(() => {
    if (!relayUrl || !data) return;
    const known = new Set(data.map((g) => g.id));
    if (rememberedIds.some((id) => !known.has(id))) {
      void query.refetch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relayUrl, data, rememberedIds.join(",")]);

  // While the NIP-11 info doc is still loading AND we have no channel data yet,
  // surface that as "loading" — otherwise a stuck/slow info fetch would read as
  // a non-loading, empty result. But once we have groups (live or seeded from
  // IndexedDB), a slow/failed NIP-11 fetch must NOT mark the channel list as
  // loading/errored: the channel list is its own stable thing and shouldn't
  // blank just because the relay's name/avatar fetch hiccuped on a shaky
  // connection. So info state only matters when there's no group data at all.
  const haveGroups = Boolean(query.data);
  const isLoading = query.isLoading || (infoLoading && !haveGroups);
  const isError = query.isError || (infoError && !haveGroups);

  return { ...query, isLoading, isError, relayInfo };
}
