import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { useLiveCommunities } from "@/concord/hooks/useCommunityList";
import { rehydrateCommunity } from "@/concord/lib/communityList";
import {
  coalesceGuestbook,
  openGuestbookOpened,
  snapshotAuthorities,
} from "@/concord/lib/guestbook";
import { queryPlane } from "@/concord/lib/rumorStore";
import { useCurrentUser } from "@/hooks/useCurrentUser";

export interface SharedCommunity {
  idHex: string;
  name: string;
}

/**
 * The viewer's Concord communities that `pubkey` is also a member of — the
 * profile page's "mutual servers" section.
 *
 * STORE-ONLY on purpose: the answer folds each community's Guestbook Plane
 * from the rumors already on disk (`queryPlane`), never mounting a per-
 * community transport or sweeping relays — a profile open must not cost one
 * network round per membership. The residual is staleness bounded by the last
 * time each community was opened, which is the right trade for a hint.
 *
 * Two deliberate simplifications against `useGuestbook`'s fold, both erring
 * toward NOT listing a community: every recorded kick is honored (`canKick`
 * true — validating one needs the control fold this hook refuses to pay for),
 * and the banlist is not consulted (a banned author's entries counting could
 * only ADD a membership; their own state is still whatever the guestbook
 * says). Membership meaning "join", both misses hide a shared community
 * rather than invent one.
 */
export function useSharedCommunities(pubkey: string | undefined) {
  const { user } = useCurrentUser();
  const entries = useLiveCommunities();
  const ids = useMemo(() => entries.map((e) => e.community_id).join(","), [entries]);
  const isSelf = !!user && user.pubkey === pubkey;

  return useQuery<SharedCommunity[]>({
    queryKey: ["shared-communities", pubkey ?? "", ids],
    // "Shared with yourself" is every community; the section hides for self.
    enabled: !!pubkey && !isSelf && entries.length > 0,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      // Each community is its own tenant, so the guestbook reads can't merge
      // into one query — but they're independent, so issue them CONCURRENTLY
      // rather than awaiting each in turn. On the native builds every read is a
      // bridge crossing plus a turn of the store's global lock; a sequential
      // loop paid each community's latency in series, which is the worst shape
      // on Android. `Promise.all` keeps the crossing COUNT (one per membership,
      // unavoidable) but overlaps their latency. Order is preserved by mapping
      // in place and filtering after.
      const resolved = await Promise.all(entries.map(async (entry): Promise<SharedCommunity | undefined> => {
        const community = rehydrateCommunity(entry);
        if (!community) return undefined;
        try {
          const stored = await queryPlane(community.idHex, "guestbook");
          const coalesced = coalesceGuestbook(openGuestbookOpened(stored), {
            nowMs: Date.now(),
            canKick: () => true,
            snapshotAuthorities: snapshotAuthorities(community),
          });
          if (coalesced.get(pubkey!)?.state === "join") {
            return { idHex: community.idHex, name: community.name };
          }
        } catch {
          // An unreadable guestbook hides this community from the list; the
          // rest still answer.
        }
        return undefined;
      }));
      return resolved.filter((c): c is SharedCommunity => c !== undefined);
    },
  });
}
