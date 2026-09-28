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
 * The viewer's communities that `pubkey` also belongs to (the profile's "mutual
 * servers"). STORE-ONLY on purpose: folds each Guestbook from disk, never hits
 * relays, so it's only as fresh as the last open. Every kick is honored and the
 * banlist is ignored — both err toward NOT listing a community.
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
      // Independent per-tenant reads, issued concurrently: each is a bridge crossing
      // on native, and a sequential loop paid them in series.
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
          // An unreadable guestbook hides only this community.
        }
        return undefined;
      }));
      return resolved.filter((c): c is SharedCommunity => c !== undefined);
    },
  });
}
