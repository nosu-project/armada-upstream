import { NSchema as n } from "@nostrify/nostrify";
import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { useDebounce } from "@/hooks/useDebounce";
import { useEventStore } from "@/hooks/useEventStore";
import { useFollowList } from "@/hooks/useFollowList";
import { seedAuthorCache } from "@/hooks/useAuthor";

import type { NostrEvent, NostrMetadata } from "@nostrify/nostrify";

export interface SearchProfile {
  pubkey: string;
  metadata: NostrMetadata;
  event: NostrEvent;
}

/**
 * Token-based match: every whitespace-separated word in the query must appear
 * somewhere in the profile's combined searchable text (name + display_name +
 * nip05). This is far more forgiving than a single contiguous-substring check —
 * it matches regardless of word order, across fields (query "sillie bear" hits
 * name="sillie", display_name="bear"), and tolerates extra/trailing spaces.
 */
function profileMatches(p: SearchProfile, query: string): boolean {
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

/**
 * Search cached author profiles in the TanStack Query cache.
 * Scans all ['author', pubkey] entries for name/display_name/nip05 matches.
 * Followed pubkeys sort first, then alphabetically.
 */
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
    const data = entry.state.data as { event?: NostrEvent; metadata?: NostrMetadata } | undefined;
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
 * Prefetch the kind-0 profiles of everyone the current user follows, so the
 * follow-prioritized search can match against them directly — even people the
 * NIP-50 search relays don't index or return, and even before they've been
 * rendered anywhere else this session. Reads from the local event store first
 * (instant), then fills gaps from relays in one batched query, and writes each
 * profile into the shared `['author', pubkey]` cache so the rest of the app
 * benefits too. Keyed only on the follow-set identity so it doesn't refetch per
 * keystroke.
 */
function useFollowProfiles(followedPubkeys: string[]) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const eventStore = useEventStore();

  // Stable key: sorted set of follows. Changes only when the follow list does.
  const key = useMemo(() => [...followedPubkeys].sort().join(","), [followedPubkeys]);

  return useQuery<SearchProfile[]>({
    queryKey: ["follow-profiles", key],
    queryFn: async ({ signal }) => {
      if (followedPubkeys.length === 0) return [];
      const store = await eventStore;

      // 1) Instant: whatever the local store already has.
      const cached = await store.query([{ kinds: [0], authors: followedPubkeys }]);
      const byPubkey = new Map<string, NostrEvent>();
      for (const ev of cached) {
        const prev = byPubkey.get(ev.pubkey);
        if (!prev || ev.created_at > prev.created_at) byPubkey.set(ev.pubkey, ev);
      }

      // 2) Fill gaps from relays in one batched query (best-effort).
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

      // Parse + seed the shared author cache so avatars/names resolve elsewhere.
      const profiles: SearchProfile[] = [];
      for (const [pubkey, event] of byPubkey) {
        try {
          const metadata = n.json().pipe(n.metadata()).parse(event.content);
          profiles.push({ pubkey, metadata, event });
          // Seed the shared author cache newest-wins, never downgrading a
          // fresher profile another path already resolved.
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
 * Search for profiles by name/nip05 (NIP-50). Used by the @-mention
 * autocomplete and the direct-invite picker.
 *
 * People the current user follows are surfaced aggressively: their profiles are
 * prefetched (see {@link useFollowProfiles}) and matched LOCALLY, then MERGED
 * ahead of the NIP-50 relay results (deduped). This is the key difference from a
 * plain relay search — a followed contact appears for a name query even when the
 * search relays don't index or return them. `followedPubkeys` is returned so
 * callers can badge follows.
 */
export function useSearchProfiles(query: string) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const { data: followData } = useFollowList();
  const followedPubkeys = useMemo(
    () => new Set(followData?.pubkeys ?? []),
    [followData?.pubkeys],
  );
  const { data: followProfiles } = useFollowProfiles(followData?.pubkeys ?? []);

  // Debounce the query so we don't hammer the relay on every keystroke
  const debouncedQuery = useDebounce(query, 300);

  const relayResults = useQuery<SearchProfile[]>({
    queryKey: ["search-profiles", debouncedQuery],
    queryFn: async ({ signal }) => {
      if (!debouncedQuery.trim()) return [];

      // NIP-50 profile search. Relays that don't support search ignore it.
      const events = await nostr.query(
        [{ kinds: [0], search: `${debouncedQuery.trim()} autocomplete:true sort:top`, limit: 10 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) },
      );

      const profiles: SearchProfile[] = [];

      for (const event of events) {
        try {
          const metadata = n.json().pipe(n.metadata()).parse(event.content);
          profiles.push({ pubkey: event.pubkey, metadata, event });
        } catch {
          // Skip invalid metadata
        }
      }

      // Deduplicate by pubkey (keep latest event)
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

  // Merge: followed contacts that match the query come FIRST (matched locally,
  // so they surface even if the relay never returned them), then relay results,
  // deduped. Falls back to the broader cache scan when nothing matches at all.
  const data = useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase();
    if (q.length < 1) return relayResults.data;

    // Local follow matches, alphabetical.
    const followMatches = (followProfiles ?? [])
      .filter((p) => profileMatches(p, q))
      .sort((a, b) => {
        const aName = (a.metadata.name || a.metadata.display_name || "").toLowerCase();
        const bName = (b.metadata.name || b.metadata.display_name || "").toLowerCase();
        return aName.localeCompare(bName);
      });

    const relayData = relayResults.data ?? [];

    if (followMatches.length === 0 && relayData.length === 0) {
      // Nothing from follows or relays — widen to the general author cache.
      return searchCachedProfiles(queryClient, q, followedPubkeys);
    }

    // Follows first, then relay hits not already present.
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

  return {
    ...relayResults,
    data,
    followedPubkeys,
  };
}

/**
 * Resolve a fixed set of pubkeys (e.g. a room's members) to profiles for the
 * @-mention autocomplete, filtered by `query`. Reads cached author metadata
 * from the Query cache; pubkeys without cached metadata still appear (matched
 * by their npub/hex) so any room member can be mentioned. Used to scope the
 * mention menu to people in the room instead of searching all of Nostr.
 */
export function useMemberProfiles(pubkeys: string[], query: string) {
  const queryClient = useQueryClient();

  return useMemo<SearchProfile[]>(() => {
    const lowerQuery = query.trim().toLowerCase();

    const profiles: SearchProfile[] = pubkeys.map((pubkey) => {
      const entry = queryClient
        .getQueryCache()
        .find({ queryKey: ["author", pubkey] });
      const data = entry?.state.data as
        | { event?: NostrEvent; metadata?: NostrMetadata }
        | undefined;
      return {
        pubkey,
        metadata: data?.metadata ?? {},
        event: data?.event ?? ({ pubkey, tags: [], content: "", kind: 0, created_at: 0, id: "", sig: "" } as NostrEvent),
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
  }, [pubkeys, query, queryClient]);
}
