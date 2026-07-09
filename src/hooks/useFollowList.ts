import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";

import { useCacheFirstSeed } from "@/hooks/useCacheFirstSeed";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { contactListPubkeys, fetchContactList } from "@/lib/contactList";

import type { NostrEvent } from "@nostrify/nostrify";

export interface FollowListData {
  /** The raw kind 3 event (null if none found). */
  event: NostrEvent | null;
  /** All pubkeys from `p` tags. */
  pubkeys: string[];
}

/**
 * Cached view of the logged-in user's follow list (kind 3), for display reads
 * like "is this person followed?" and follow-prioritized search. Ported from
 * Ditto's `useFollowList`.
 *
 * Reads via `fetchContactList`, which queries relays then falls back to the
 * IndexedDB event store on a relay miss so an existing follow list isn't
 * blanked out by a transient empty response. Seeds cache-first from the store
 * so follows are available on first render without waiting for the round-trip.
 */
export function useFollowList() {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
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
      const event = await fetchContactList(nostr, store, user.pubkey, { signal, timeout: 5000 });
      return { event, pubkeys: contactListPubkeys(event) };
    },
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
  });
}
