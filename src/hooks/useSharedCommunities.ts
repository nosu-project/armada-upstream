import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { useCommunityList } from "@/concord/hooks/useCommunityList";
import { liveEntries, rehydrateCommunity } from "@/concord/lib/communityList";
import { citationSatisfied, readControlFold } from "@/concord/lib/control";
import {
  coalesceGuestbook,
  completeMemberlist,
  snapshotAuthorities,
} from "@/concord/lib/guestbook";
import { canActOnMember, Permissions } from "@/concord/lib/roles";
import { queryPlane } from "@/concord/lib/rumorStore";
import type { Community } from "@/concord/lib/types";

/**
 * Per peer, a community the viewer shares with them ("Also in Foo") for DM requests. Purely
 * local (decrypted Guestbook Plane in the rumor store). Concord only, so coverage is partial — safe
 * only as a positive label, never a gate; absence means no information.
 */
export function useSharedCommunities(
  peers: string[],
  enabled = true,
): Map<string, string> {
  const { data: listData } = useCommunityList();

  const communities = useMemo(() => {
    if (!listData) return [];
    const out: Community[] = [];
    for (const entry of liveEntries(listData.list)) {
      const community = rehydrateCommunity(entry);
      if (community) out.push(community);
    }
    return out;
  }, [listData]);

  // Keyed on content: `peers` is rebuilt every render.
  const peerKey = useMemo(() => [...peers].sort().join(","), [peers]);
  const communityKey = useMemo(
    () =>
      communities
        .map((c) => `${c.idHex}:${c.heldRoots.map((r) => r.epoch).join("-")}`)
        .sort()
        .join(","),
    [communities],
  );

  const { data } = useQuery<Record<string, string>>({
    queryKey: ["dm-shared-communities", communityKey, peerKey],
    enabled: enabled && peers.length > 0 && communities.length > 0,
    staleTime: 60_000,
    queryFn: async () => {
      const out: Record<string, string> = {};
      for (const community of communities) {
        // One read per community: each guestbook is in its own tenant.
        const events = await queryPlane(community.idHex, "guestbook");
        if (!events.length) continue;
        // Without a fold nobody is kicked or banned, so it can only over-include — fine for a hint.
        const folded = await readControlFold(community.idHex);
        const coalesced = coalesceGuestbook(events, {
          nowMs: Date.now(),
          canKick: (actor, target, citation) =>
            Boolean(
              folded &&
                canActOnMember(folded.roster, actor, folded.ownerHex, target, Permissions.KICK) &&
                citationSatisfied(folded, community.id, actor, citation),
            ),
          // Snapshots honored only from the epoch's Refounding author. Mirrors useGuestbook.
          snapshotAuthorities: snapshotAuthorities(community),
          banned: folded?.banned,
        });
        // No `observed` healing: the Guestbook alone is enough for a hint.
        const members = completeMemberlist(
          coalesced,
          new Map(),
          folded?.banned ?? new Set(),
          folded?.bannedAt,
        );
        // First community wins — the label has room for one.
        for (const peer of peers) {
          if (!out[peer] && members.has(peer)) out[peer] = community.name;
        }
      }
      return out;
    },
  });

  return useMemo(() => new Map(Object.entries(data ?? {})), [data]);
}
