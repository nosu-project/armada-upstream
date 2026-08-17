import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";

import { useEventStore } from "@/hooks/useEventStore";

/**
 * The NIP-85 user-stats provider (kind 30382, one event per subject pubkey in
 * the `d` tag). Follower counts can't be computed client-side — that's a scan
 * of every kind 3 on the network — so like Ditto we read them from a stats
 * pubkey, defaulting to the same provider Ditto ships.
 */
const NIP85_STATS_PUBKEY: string =
  import.meta.env.VITE_NIP85_STATS_PUBKEY ??
  "5f68e85ee174102ca8978eef302129f081f03456c884185d5ec1c1224ab633ea";

/** A pubkey's follower count per the NIP-85 stats provider, or null. */
export function useFollowerCount(pubkey: string | undefined) {
  const { nostr } = useNostr();

  return useQuery<number | null>({
    queryKey: ["nip85-followers", pubkey ?? "", NIP85_STATS_PUBKEY],
    enabled: !!pubkey && !!NIP85_STATS_PUBKEY,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: async ({ signal }) => {
      const [event] = await nostr.query(
        [{ kinds: [30382], authors: [NIP85_STATS_PUBKEY], "#d": [pubkey!], limit: 1 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]) },
      );
      const raw = event?.tags.find(([n]) => n === "followers")?.[1];
      const count = raw ? parseInt(raw, 10) : NaN;
      return Number.isFinite(count) ? count : null;
    },
  });
}

/**
 * How many people a pubkey follows — the `p` tags of their kind 3. Also
 * returns the list itself for consumers that need it (shared followers).
 */
export function useFollowingOf(pubkey: string | undefined) {
  const { nostr } = useNostr();
  const eventStore = useEventStore();

  return useQuery<{ count: number; pubkeys: string[] } | null>({
    queryKey: ["following-of", pubkey ?? ""],
    enabled: !!pubkey,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
    queryFn: async ({ signal }) => {
      const store = await eventStore;
      const [fromNet] = await nostr.query(
        [{ kinds: [3], authors: [pubkey!], limit: 1 }],
        { signal },
      );
      let event = fromNet as { tags: string[][]; created_at: number } | undefined;
      if (fromNet) {
        void store.event(fromNet);
      } else {
        [event] = await store.query([{ kinds: [3], authors: [pubkey!] }]);
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
  });
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
