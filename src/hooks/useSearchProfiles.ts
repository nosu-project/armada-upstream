import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { useDebounce } from "@/hooks/useDebounce";
import { useEventStore } from "@/hooks/useEventStore";
import { useFollowList } from "@/hooks/useFollowList";
import { useMutedPubkeys } from "@/hooks/useMuteList";
import { metadataSchema, seedAuthorCache } from "@/lib/authorCache";

import type { NostrMetadata } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";

export interface SearchProfile {
  pubkey: string;
  metadata: NostrMetadata;
  event: NostrRumor;
}

/** Every query word must appear somewhere in name + display_name + nip05 (any order, any field). */
export function profileMatches(p: SearchProfile, query: string): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  const haystack = [
    p.metadata.name,
    p.metadata.display_name,
    p.metadata.nip05,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return tokens.every((t) => haystack.includes(t));
}

/** Scan cached ['author', pubkey] entries; follows first, then alphabetical. */
function searchCachedProfiles(
  queryClient: ReturnType<typeof useQueryClient>,
  query: string,
  followedPubkeys: Set<string>,
  limit: number = 10,
): SearchProfile[] {
  const lowerQuery = query.toLowerCase();
  const results: SearchProfile[] = [];

  const cache = queryClient.getQueryCache().findAll({ queryKey: ["author"] });

  for (const entry of cache) {
    const data = entry.state.data as { event?: NostrRumor; metadata?: NostrMetadata } | undefined;
    if (!data?.event || !data?.metadata) continue;

    const profile: SearchProfile = { pubkey: data.event.pubkey, metadata: data.metadata, event: data.event };
    if (profileMatches(profile, lowerQuery)) results.push(profile);
  }

  results.sort((a, b) => {
    const aFollowed = followedPubkeys.has(a.pubkey) ? 0 : 1;
    const bFollowed = followedPubkeys.has(b.pubkey) ? 0 : 1;
    if (aFollowed !== bFollowed) return aFollowed - bFollowed;
    const aName = (a.metadata.name || a.metadata.display_name || "").toLowerCase();
    const bName = (b.metadata.name || b.metadata.display_name || "").toLowerCase();
    return aName.localeCompare(bName);
  });

  return results.slice(0, limit);
}

/**
 * Prefetch followed users' kind-0s (store first, then one batched relay query) so follow
 * matches work even when NIP-50 relays don't return them. Keyed on the follow set only.
 */
function useFollowProfiles(followedPubkeys: string[]) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const eventStore = useEventStore();

  const key = useMemo(() => [...followedPubkeys].sort().join(","), [followedPubkeys]);

  return useQuery<SearchProfile[]>({
    queryKey: ["follow-profiles", key],
    queryFn: async ({ signal }) => {
      if (followedPubkeys.length === 0) return [];
      const store = await eventStore;

      const cached = await store.query([{ kinds: [0], authors: followedPubkeys }]);
      const byPubkey = new Map<string, NostrRumor>();
      for (const ev of cached) {
        const prev = byPubkey.get(ev.pubkey);
        if (!prev || ev.created_at > prev.created_at) byPubkey.set(ev.pubkey, ev);
      }

      const missing = followedPubkeys.filter((pk) => !byPubkey.has(pk));
      if (missing.length > 0) {
        try {
          const fresh = await nostr.query(
            [{ kinds: [0], authors: missing }],
            { signal: AbortSignal.any([signal, AbortSignal.timeout(6000)]) },
          );
          for (const ev of fresh) {
            const prev = byPubkey.get(ev.pubkey);
            if (!prev || ev.created_at > prev.created_at) {
              byPubkey.set(ev.pubkey, ev);
              void store.event(ev);
            }
          }
        } catch {
          // Relay miss — the cached subset still powers follow-prioritized matches.
        }
      }

      const profiles: SearchProfile[] = [];
      for (const [pubkey, event] of byPubkey) {
        try {
          const metadata = metadataSchema.parse(event.content);
          profiles.push({ pubkey, metadata, event });
          // Newest-wins, never downgrading a fresher profile.
          seedAuthorCache(queryClient, pubkey, event);
        } catch {
          // Skip unparseable metadata.
        }
      }
      return profiles;
    },
    enabled: followedPubkeys.length > 0,
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * NIP-50 profile search for @-mention autocomplete and the invite picker. Follows are matched
 * LOCALLY and merged ahead of relay results, so they appear even when relays don't index them.
 */
export function useSearchProfiles(query: string) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const { mutedPubkeys } = useMutedPubkeys();
  const { data: followData } = useFollowList();
  const followedPubkeys = useMemo(
    () => new Set(followData?.pubkeys ?? []),
    [followData?.pubkeys],
  );
  const { data: followProfiles } = useFollowProfiles(followData?.pubkeys ?? []);

  const debouncedQuery = useDebounce(query, 300);

  const relayResults = useQuery<SearchProfile[]>({
    queryKey: ["search-profiles", debouncedQuery],
    queryFn: async ({ signal }) => {
      if (!debouncedQuery.trim()) return [];

      // Relays without NIP-50 ignore `search`.
      const events = await nostr.query(
        [{ kinds: [0], search: `${debouncedQuery.trim()} autocomplete:true sort:top`, limit: 10 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) },
      );

      const profiles: SearchProfile[] = [];

      for (const event of events) {
        try {
          const metadata = metadataSchema.parse(event.content);
          profiles.push({ pubkey: event.pubkey, metadata, event });
        } catch {
          // Skip invalid metadata
        }
      }

      const seen = new Map<string, SearchProfile>();
      for (const profile of profiles) {
        const existing = seen.get(profile.pubkey);
        if (!existing || profile.event.created_at > existing.event.created_at) {
          seen.set(profile.pubkey, profile);
        }
      }

      return Array.from(seen.values());
    },
    enabled: debouncedQuery.trim().length >= 1,
    staleTime: 30 * 1000,
    placeholderData: (prev) => prev,
  });

  // Follows first, then relay results; falls back to a cache-wide scan when nothing matches.
  const data = useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase();
    if (q.length < 1) return relayResults.data;

    const followMatches = (followProfiles ?? [])
      .filter((p) => profileMatches(p, q))
      .sort((a, b) => {
        const aName = (a.metadata.name || a.metadata.display_name || "").toLowerCase();
        const bName = (b.metadata.name || b.metadata.display_name || "").toLowerCase();
        return aName.localeCompare(bName);
      });

    const relayData = relayResults.data ?? [];

    if (followMatches.length === 0 && relayData.length === 0) {
      return searchCachedProfiles(queryClient, q, followedPubkeys);
    }

    const merged: SearchProfile[] = [...followMatches];
    const have = new Set(followMatches.map((p) => p.pubkey));
    for (const p of relayData) {
      if (!have.has(p.pubkey)) {
        merged.push(p);
        have.add(p.pubkey);
      }
    }
    return merged;
  }, [relayResults.data, followProfiles, followedPubkeys, debouncedQuery, queryClient]);

  // Muting applied to the MERGED result so no source path can reintroduce a muted person.
  const visible = useMemo(
    () => (mutedPubkeys.size === 0 ? data : data?.filter((p) => !mutedPubkeys.has(p.pubkey))),
    [data, mutedPubkeys],
  );

  return {
    ...relayResults,
    data: visible,
    followedPubkeys,
  };
}

/**
 * A fixed member set for scoped @-mention autocomplete; members without cached metadata still
 * match by npub/hex.
 */
export function useMemberProfiles(pubkeys: string[], query: string) {
  const queryClient = useQueryClient();
  const { mutedPubkeys } = useMutedPubkeys();

  return useMemo<SearchProfile[]>(() => {
    const lowerQuery = query.trim().toLowerCase();

    const profiles: SearchProfile[] = pubkeys.filter((pk) => !mutedPubkeys.has(pk)).map((pubkey) => {
      // `getQueryData` hashes once; `getQueryCache().find` stringifies every key (was the hottest
      // app frame in a profile).
      const data = queryClient.getQueryData(["author", pubkey]) as
        | { event?: NostrRumor; metadata?: NostrMetadata }
        | undefined;
      return {
        pubkey,
        metadata: data?.metadata ?? {},
        event: data?.event ?? ({ pubkey, tags: [], content: "", kind: 0, created_at: 0, id: "" } satisfies NostrRumor),
      };
    });

    const matched = lowerQuery
      ? profiles.filter(
          (p) => profileMatches(p, lowerQuery) || p.pubkey.startsWith(lowerQuery),
        )
      : profiles;

    matched.sort((a, b) => {
      const aName = (a.metadata.name || a.metadata.display_name || a.pubkey).toLowerCase();
      const bName = (b.metadata.name || b.metadata.display_name || b.pubkey).toLowerCase();
      return aName.localeCompare(bName);
    });

    return matched.slice(0, 10);
  }, [pubkeys, query, queryClient, mutedPubkeys]);
}
