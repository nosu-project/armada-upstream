import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { useCommunityList2 } from "@/concord-v2/hooks/useCommunityList2";
import { controlFoldKey } from "@/concord-v2/hooks/useControlPlane2";
import { liveEntries, rehydrateCommunity } from "@/concord-v2/lib/communityList";
import { citationSatisfied, type FoldedControl } from "@/concord-v2/lib/control";
import {
  coalesceGuestbook,
  completeMemberlist,
  snapshotAuthorities,
} from "@/concord-v2/lib/guestbook";
import { canActOnMember, Permissions } from "@/concord-v2/lib/roles";
import { queryPlane } from "@/concord-v2/lib/rumorStore";
import type { CommunityV2 } from "@/concord-v2/lib/types";
import { readFolded } from "@/lib/foldedCache";

/**
 * For each of `peers`, a community the viewer shares with them — the trust hint
 * shown on DM requests ("Also in Foo").
 *
 * PURELY LOCAL. The Guestbook Plane is persisted DECRYPTED in the rumor store
 * and the global `ControlPlaneSync` sweep already keeps it fresh for every
 * joined community (including ones never opened), so this is one indexed
 * IndexedDB read per joined community — no network, no decrypt, no signer.
 *
 * COVERAGE IS PARTIAL, BY DESIGN OF THE PROTOCOLS — Concord v1 has no
 * membership plane at all (plain key-holders aren't enumerable), and NIP-29
 * relays frequently publish no kind-39002 member list. So this answers for
 * Concord v2 only.
 *
 * That is safe ONLY because the result is a label, never a gate: a hit promotes
 * a request out of the anonymous pile, and a miss leaves it exactly where it
 * already was. Callers must render it as a positive assertion ("also in X") and
 * must never render its absence as "shares nothing with you" — absence means no
 * information. If this ever becomes an admission rule for the main DM list, the
 * partial coverage stops being acceptable.
 */
export function useSharedCommunities(
  peers: string[],
  enabled = true,
): Map<string, string> {
  const { data: listData } = useCommunityList2();

  const communities = useMemo(() => {
    if (!listData) return [];
    const out: CommunityV2[] = [];
    for (const entry of liveEntries(listData.list)) {
      const community = rehydrateCommunity(entry);
      if (community) out.push(community);
    }
    return out;
  }, [listData]);

  // Keys over CONTENT, not array identity: `peers` is rebuilt every render by
  // the caller's row memo, and the community set changes whenever a held epoch
  // does (which changes the derived guestbook addresses).
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
        // One read per community, because each community's guestbook lives in
        // its own rumor-store tenant. This used to be a single read across every
        // community's streams at once, de-multiplexed afterwards by each event's
        // own `stream` tag — cheaper, but it relied on that tag being honest
        // about which community an event belonged to.
        const events = await queryPlane(community.idHex, "guestbook");
        if (!events.length) continue;
        // The persisted control fold supplies kick authority and the banlist.
        // On a miss we still coalesce, but no kick is honored and nobody is
        // banned — so an absent fold can only ever over-include. Acceptable
        // for a hint; it would not be for a gate.
        const folded = await readFolded<FoldedControl>(controlFoldKey(community.idHex));
        const coalesced = coalesceGuestbook(events, {
          nowMs: Date.now(),
          canKick: (actor, target, citation) =>
            Boolean(
              folded &&
                canActOnMember(folded.roster, actor, folded.ownerHex, target, Permissions.KICK) &&
                citationSatisfied(folded, community.id, actor, citation),
            ),
          // A snapshot is honored only from the npub whose Refounding minted
          // the epoch carrying it; at genesis there is none. Mirrors
          // useGuestbook2.
          snapshotAuthorities: snapshotAuthorities(community),
          banned: folded?.banned,
        });
        // No `observed` map: healing from message authorship would mean reading
        // every channel's rumors, and the Guestbook alone is enough for a hint.
        const members = completeMemberlist(
          coalesced,
          new Map(),
          folded?.banned ?? new Set(),
          folded?.bannedAt,
        );
        // First community wins — the label has room for exactly one.
        for (const peer of peers) {
          if (!out[peer] && members.has(peer)) out[peer] = community.name;
        }
      }
      return out;
    },
  });

  return useMemo(() => new Map(Object.entries(data ?? {})), [data]);
}
