import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { useControlFold2 } from "@/concord-v2/hooks/useControlPlane2";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import {
  buildJoinRumor,
  buildKickRumor,
  buildLeaveRumor,
  coalesceGuestbook,
  completeMemberlist,
  currentGuestbookGroup,
  guestbookGroups,
  openGuestbookOpened,
  sealGuestbook,
  type CoalescedMember,
} from "@/concord-v2/lib/guestbook";
import { mergeOpened, sweepGuestbook } from "@/concord-v2/lib/planeSync";
import { queryByStreams } from "@/concord-v2/lib/rumorStore";
import type { OpenedEvent } from "@/concord-v2/lib/stream";
import { canActOnMember, Permissions } from "@/concord-v2/lib/roles";
import type { CommunityV2 } from "@/concord-v2/lib/types";

/**
 * The Guestbook Plane (CORD-02 §5): membership motion, coalesced flat.
 * Off-consensus, so it polls lazily. Fetch/decrypt/cursor via
 * {@link sweepGuestbook}; wraps decrypted once into the opened-event cache.
 */
export function useGuestbook2(community: CommunityV2 | undefined) {
  const { nostr } = useNostr();
  const { data: folded } = useControlFold2(community);

  const query = useQuery<OpenedEvent[]>({
    queryKey: ["concord2", "guestbook", community?.idHex ?? null, community?.rootEpoch.toString() ?? ""],
    enabled: Boolean(community),
    staleTime: 30_000,
    refetchInterval: 60_000,
    queryFn: async () => {
      const fresh = await sweepGuestbook(nostr, community!);
      const stored = await queryByStreams(guestbookGroups(community!).map((g) => g.pk));
      return mergeOpened(stored, fresh);
    },
  });

  const coalesced = useMemo(() => {
    if (!community || !query.data) return new Map<string, CoalescedMember>();
    const opened = openGuestbookOpened(query.data);
    // A snapshot is honored only from the npub whose Refounding minted the
    // epoch — recorded on adoption as a list-entry extension; genesis has none.
    const snapshotAuthority = community.rootEpoch === 0n ? community.owner : refounderOf(community);
    return coalesceGuestbook(opened, {
      nowMs: Date.now(),
      canKick: (actor, target) =>
        Boolean(folded && canActOnMember(folded.roster, actor, folded.ownerHex, target, Permissions.KICK)),
      snapshotAuthority,
    });
  }, [community, query.data, folded]);

  return { ...query, coalesced };
}

/** The recorded refounder of the community's current epoch (Armada extension). */
function refounderOf(community: CommunityV2): string | undefined {
  // Recorded on rekey adoption; falls back to the owner (who can always refound).
  return community.refounder ?? community.owner;
}

/**
 * The Complete Memberlist: coalesced Guestbook ∪ observed authors − Banlist.
 * `observed` should map every author seen publishing (messages, editions) to
 * the newest ms they were seen.
 */
export function useMembers2(
  community: CommunityV2 | undefined,
  observed: Map<string, number>,
): { members: Set<string>; coalesced: Map<string, CoalescedMember> } {
  const { coalesced } = useGuestbook2(community);
  const { data: folded } = useControlFold2(community);
  const members = useMemo(
    () => completeMemberlist(coalesced, observed, folded?.banned ?? new Set()),
    [coalesced, observed, folded],
  );
  return { members, coalesced };
}

/** Publish one guestbook rumor to the community relays. */
export function useGuestbookPublisher2(community: CommunityV2 | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (
      action:
        | { type: "join"; attribution?: { creator: string; label?: string } }
        | { type: "leave" }
        | { type: "kick"; target: string; vac?: { eid: string; version: bigint; hash: string } },
    ) => {
      if (!user || !community) throw new Error("Not ready.");
      const group = currentGuestbookGroup(community);
      const ms = Date.now();
      const rumor =
        action.type === "join"
          ? buildJoinRumor(user.pubkey, ms, action.attribution)
          : action.type === "leave"
            ? buildLeaveRumor(user.pubkey, ms)
            : buildKickRumor(user.pubkey, action.target, ms, action.vac);
      const wrap = await sealGuestbook(rumor, group, user.signer);
      const results = await Promise.allSettled(
        community.relays.map((url) => nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(8000) })),
      );
      if (!results.some((r) => r.status === "fulfilled")) {
        throw new Error("No relay accepted the update.");
      }
    },
    onSuccess: () => {
      if (community) {
        queryClient.invalidateQueries({ queryKey: ["concord2", "guestbook", community.idHex] });
      }
    },
  });
}
