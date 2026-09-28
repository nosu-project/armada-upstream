import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";

import { selfStateRelays } from "@/contexts/AppContext";
import { useAppContext } from "@/hooks/useAppContext";
import { useCacheFirstSeed } from "@/hooks/useCacheFirstSeed";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { newestCanonicalSelfList } from "@/lib/canonicalSelfList";
import { contactListPubkeys, readCachedContactList } from "@/lib/contactList";
import { queryExplicitRelaysWithStatus, uniqueRelayUrls } from "@/lib/nip65";

import type { NostrRumor } from "@/lib/nostrRumor";

export interface FollowListData {
  event: NostrRumor | null;
  pubkeys: string[];
  /** Cache-first seeds omit this; only a completed live read sets it true. */
  wireReady?: boolean;
}

/**
 * The user's follow list (kind 3) for display reads, ported from Ditto. `fetchContactList`
 * falls back to the event store on a relay miss; seeded cache-first for first render.
 */
export function useFollowList() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const eventStore = useEventStore();

  useCacheFirstSeed<FollowListData>({
    queryKey: user ? ["follow-list", user.pubkey] : undefined,
    filter: { kinds: [3], authors: user ? [user.pubkey] : [] },
    toData: (event) => ({ event, pubkeys: contactListPubkeys(event) }),
    getEvent: (data) => data.event ?? undefined,
  });

  return useQuery<FollowListData>({
    queryKey: ["follow-list", user?.pubkey ?? ""],
    queryFn: async ({ signal }) => {
      if (!user) return { event: null, pubkeys: [] };
      const store = await eventStore;
      const relays = uniqueRelayUrls(selfStateRelays(config, user.pubkey)).sort();
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
      const [wire, cached] = await Promise.all([
        queryExplicitRelaysWithStatus(
          nostr,
          relays,
          [{ kinds: [3], authors: [user.pubkey], limit: 1 }],
          deadline,
        ),
        readCachedContactList(store, user.pubkey).catch(() => null),
      ]);
      for (const event of wire.events) void store.event(event);
      const event = newestCanonicalSelfList(
        [...wire.events, ...(cached ? [cached] : [])],
        user.pubkey,
        3,
      ) ?? null;
      const answered = new Set(wire.answered);
      return {
        event,
        pubkeys: contactListPubkeys(event),
        // Fallback / partial reads are additive only: a missing relay may hold a newer list.
        wireReady: relays.length > 0
          && relays.every((relay) => answered.has(relay)),
      };
    },
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
  });
}
