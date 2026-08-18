import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";

import { useEventStore } from "@/hooks/useEventStore";

type EventStore = ReturnType<typeof useEventStore>;
type Nostr = ReturnType<typeof useNostr>["nostr"];

/**
 * The NIP-85 user-stats provider (kind 30382, one event per subject pubkey in
 * the `d` tag). Follower counts can't be computed client-side — that's a scan
 * of every kind 3 on the network — so like Ditto we read them from a stats
 * pubkey, defaulting to the same provider Ditto ships.
 */
const NIP85_STATS_PUBKEY: string =
  import.meta.env.VITE_NIP85_STATS_PUBKEY ??
  "5f68e85ee174102ca8978eef302129f081f03456c884185d5ec1c1224ab633ea";

const followerCount = (event: { tags: string[][] } | undefined): number | null => {
  const raw = event?.tags.find(([n]) => n === "followers")?.[1];
  const count = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(count) ? count : null;
};

export function followerCountQueryKey(pubkey: string): [string, string, string] {
  return ["nip85-followers", pubkey, NIP85_STATS_PUBKEY];
}

/**
 * A pubkey's follower count per the NIP-85 stats provider, or null.
 *
 * Store-first: a count is a hint, and last open's hint on screen now beats the
 * right one a relay round trip later — so a stored 30382 answers immediately
 * and the network refreshes it in place. The provider's events are persisted
 * for that purpose; nothing else writes them.
 */
export function followerCountQueryOptions(
  nostr: Nostr,
  eventStore: EventStore,
  pubkey: string | undefined,
) {
  return {
    queryKey: followerCountQueryKey(pubkey ?? ""),
    enabled: !!pubkey && !!NIP85_STATS_PUBKEY,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<number | null> => {
      const store = await eventStore;
      const filter = { kinds: [30382], authors: [NIP85_STATS_PUBKEY], "#d": [pubkey!] };
      const [cached] = await store.query([filter]);
      const fetching = Promise.resolve(
        nostr.query([{ ...filter, limit: 1 }], {
          signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]),
        }),
      );
      if (cached) {
        void fetching
          .then(([fresh]) => {
            if (fresh && fresh.created_at > cached.created_at) void store.event(fresh);
          })
          .catch(() => undefined);
        return followerCount(cached);
      }
      const [event] = await fetching;
      if (event) void store.event(event);
      return followerCount(event);
    },
  };
}

export function useFollowerCount(pubkey: string | undefined) {
  const { nostr } = useNostr();
  const eventStore = useEventStore();
  return useQuery<number | null>(followerCountQueryOptions(nostr, eventStore, pubkey));
}

/**
 * How many people a pubkey follows — the `p` tags of their kind 3. Also
 * returns the list itself for consumers that need it (shared followers).
 */
export function followingOfQueryKey(pubkey: string): [string, string] {
  return ["following-of", pubkey];
}

export function followingOfQueryOptions(
  nostr: Nostr,
  eventStore: EventStore,
  pubkey: string | undefined,
) {
  return {
    queryKey: followingOfQueryKey(pubkey ?? ""),
    enabled: !!pubkey,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const store = await eventStore;
      // Store-first for the same reason as the badge list: a kind 3 is
      // replaceable and often large, and the count it yields is a hint. The
      // network copy refreshes the store behind the answer.
      const [cached] = await store.query([{ kinds: [3], authors: [pubkey!] }]);
      let event = cached as { tags: string[][]; created_at: number } | undefined;
      if (cached) {
        void Promise.resolve(nostr.query([{ kinds: [3], authors: [pubkey!], limit: 1 }], { signal }))
          .then(([fresh]) => {
            if (fresh && fresh.created_at > cached.created_at) void store.event(fresh);
          })
          .catch(() => undefined);
      } else {
        const [fromNet] = await nostr.query(
          [{ kinds: [3], authors: [pubkey!], limit: 1 }],
          { signal },
        );
        event = fromNet;
        if (fromNet) void store.event(fromNet);
      }
      if (!event) return null;
      const pubkeys = [
        ...new Set(
          event.tags
            .filter((t) => t[0] === "p" && /^[0-9a-f]{64}$/i.test(t[1] ?? ""))
            .map((t) => t[1].toLowerCase()),
        ),
      ];
      return { count: pubkeys.length, pubkeys };
    },
  };
}

export function useFollowingOf(pubkey: string | undefined) {
  const { nostr } = useNostr();
  const eventStore = useEventStore();
  return useQuery<{ count: number; pubkeys: string[] } | null>(
    followingOfQueryOptions(nostr, eventStore, pubkey),
  );
}

export interface SharedFollowers {
  /** Every shared follower found, best-ranked first. */
  pubkeys: string[];
  count: number;
}

/**
 * "Followed by people you follow": the viewer's follows whose OWN kind 3
 * includes `pubkey`. One `authors × #p` query answers it — each result is a
 * follow list naming the profile, authored by someone the viewer follows.
 *
 * Ranked by the NIP-85 stats provider's follower counts (one `#d` batch
 * query), so the most-established accounts lead the preview row.
 */
export function useSharedFollowers(
  pubkey: string | undefined,
  viewerFollows: string[] | undefined,
) {
  const { nostr } = useNostr();
  // The follows list churns identity per fetch; key on content.
  const followsKey = viewerFollows?.length ?? 0;

  return useQuery<SharedFollowers>({
    queryKey: ["shared-followers", pubkey ?? "", followsKey],
    enabled: !!pubkey && !!viewerFollows && viewerFollows.length > 0,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: async ({ signal }) => {
      // Bound the author set: relays cap filter sizes, and past ~1000 authors
      // the query is likelier to be truncated than answered.
      const authors = viewerFollows!.slice(0, 1000).filter((p) => p !== pubkey);
      if (authors.length === 0) return { pubkeys: [], count: 0 };

      const lists = await nostr.query(
        [{ kinds: [3], authors, "#p": [pubkey!] }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
      );
      // Replaceable: keep only each author's newest list, and re-check the
      // `p` tag — a relay serving an older replaced version may no longer
      // match the filter it answered.
      const newest = new Map<string, (typeof lists)[number]>();
      for (const list of lists) {
        const prev = newest.get(list.pubkey);
        if (!prev || prev.created_at < list.created_at) newest.set(list.pubkey, list);
      }
      const shared = [...newest.values()]
        .filter((l) => l.tags.some((t) => t[0] === "p" && t[1] === pubkey))
        .map((l) => l.pubkey);
      if (shared.length === 0) return { pubkeys: [], count: 0 };

      // Rank by the stats provider's follower counts; unknowns sort last in
      // their original order.
      const rank = new Map<string, number>();
      if (NIP85_STATS_PUBKEY) {
        try {
          const stats = await nostr.query(
            [{ kinds: [30382], authors: [NIP85_STATS_PUBKEY], "#d": shared }],
            { signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]) },
          );
          for (const s of stats) {
            const subject = s.tags.find(([n]) => n === "d")?.[1];
            const followers = parseInt(s.tags.find(([n]) => n === "followers")?.[1] ?? "", 10);
            if (subject && Number.isFinite(followers)) rank.set(subject, followers);
          }
        } catch {
          // Unranked is still shared; fall through to the unsorted list.
        }
      }
      const ranked = [...shared].sort((a, b) => (rank.get(b) ?? -1) - (rank.get(a) ?? -1));
      return { pubkeys: ranked, count: ranked.length };
    },
  });
}
