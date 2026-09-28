import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";

import { useEventStore } from "@/hooks/useEventStore";

type EventStore = ReturnType<typeof useEventStore>;
type Nostr = ReturnType<typeof useNostr>["nostr"];

/**
 * NIP-85 user-stats provider (kind 30382, `d` = subject). Follower counts can't be computed
 * client-side, so like Ditto we read them from a stats pubkey.
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

/** Store-first: a count is a hint, so show the stored 30382 now and refresh in place. */
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
      // Store-first: a kind 3 is large and the count is only a hint.
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
  pubkeys: string[];
  count: number;
}

/** "Followed by people you follow" via one `authors × #p` query, ranked by NIP-85 follower counts. */
export function useSharedFollowers(
  pubkey: string | undefined,
  viewerFollows: string[] | undefined,
) {
  const { nostr } = useNostr();
  const followsKey = viewerFollows?.length ?? 0;

  return useQuery<SharedFollowers>({
    queryKey: ["shared-followers", pubkey ?? "", followsKey],
    enabled: !!pubkey && !!viewerFollows && viewerFollows.length > 0,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: async ({ signal }) => {
      // Relays cap filter sizes; past ~1000 authors truncation is likely.
      const authors = viewerFollows!.slice(0, 1000).filter((p) => p !== pubkey);
      if (authors.length === 0) return { pubkeys: [], count: 0 };

      const lists = await nostr.query(
        [{ kinds: [3], authors, "#p": [pubkey!] }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
      );
      // Keep each author's newest list and re-check `p`: an older replaced version may not match.
      const newest = new Map<string, (typeof lists)[number]>();
      for (const list of lists) {
        const prev = newest.get(list.pubkey);
        if (!prev || prev.created_at < list.created_at) newest.set(list.pubkey, list);
      }
      const shared = [...newest.values()]
        .filter((l) => l.tags.some((t) => t[0] === "p" && t[1] === pubkey))
        .map((l) => l.pubkey);
      if (shared.length === 0) return { pubkeys: [], count: 0 };

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
