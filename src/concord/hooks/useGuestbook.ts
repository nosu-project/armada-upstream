import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { useControlFold, useDissolved } from "@/concord/hooks/useControlPlane";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import {
  buildJoinRumor,
  buildKickRumor,
  buildLeaveRumor,
  coalesceGuestbook,
  completeMemberlist,
  currentGuestbookGroup,
  openGuestbookOpened,
  sealGuestbook,
  snapshotAuthorities,
  type CoalescedMember,
} from "@/concord/lib/guestbook";
import { mergeOpened, sweepGuestbook } from "@/concord/lib/planeSync";
import { queryPlane } from "@/concord/lib/rumorStore";
import type { OpenedEvent } from "@/concord/lib/stream";
import { citationSatisfied } from "@/concord/lib/control";
import { canActOnMember, Permissions } from "@/concord/lib/roles";
import type { Community } from "@/concord/lib/types";

/**
 * The Guestbook Plane (CORD-02 §5): membership motion, coalesced flat.
 * Off-consensus, so it polls lazily. Fetch/decrypt/cursor via
 * {@link sweepGuestbook}; wraps decrypted once into the opened-event cache.
 */
export function useGuestbook(community: Community | undefined) {
  const { nostr } = useNostr();
  const { data: folded } = useControlFold(community);
  const { data: dissolvedAtMs } = useDissolved(community);

  const query = useQuery<OpenedEvent[]>({
    queryKey: ["concord", "guestbook", community?.idHex ?? null, community?.rootEpoch.toString() ?? ""],
    enabled: Boolean(community),
    staleTime: 30_000,
    refetchInterval: 60_000,
    queryFn: async () => {
      const fresh = await sweepGuestbook(nostr, community!);
      const stored = await queryPlane(community!.idHex, "guestbook");
      return mergeOpened(stored, fresh);
    },
  });

  const coalesced = useMemo(() => {
    if (!community || !query.data) return new Map<string, CoalescedMember>();
    const opened = openGuestbookOpened(query.data);
    // A snapshot is honored only from the npub whose Refounding minted the
    // epoch carrying it (CORD-02 §5). The sweep spans EVERY held epoch's
    // guestbook, so the authority is the set of recorded refounders — matching
    // only the current one silently dropped every prior epoch's snapshot. At
    // genesis (epoch 0) there is no snapshot; an epoch with no recorded
    // refounder contributes no authority, so we accept NO snapshot for it
    // rather than falling back to the owner.
    const authorities = snapshotAuthorities(community);
    return coalesceGuestbook(opened, {
      nowMs: Date.now(),
      canKick: (actor, target, citation, atMs) =>
        Boolean(
          // Death wins every race (CORD-02 §9) — an ORDERING rule, since the
          // coalesce replays history: only a kick published AFTER the tombstone
          // is refused, or every kick the community ever honored would un-kick
          // the moment it was dissolved.
          !(dissolvedAtMs != null && atMs > dissolvedAtMs) &&
            folded &&
            canActOnMember(folded.roster, actor, folded.ownerHex, target, Permissions.KICK) &&
            // …and the CORD-04 §5 sync floor, so a kick from an admin whose
            // demotion we haven't read yet parks instead of landing.
            citationSatisfied(folded, community.id, actor, citation),
        ),
      snapshotAuthorities: authorities,
      banned: folded?.banned,
    });
  }, [community, query.data, folded, dissolvedAtMs]);

  return { ...query, coalesced };
}

/**
 * The Complete Memberlist: coalesced Guestbook ∪ observed authors − Banlist.
 * `observed` should map every author seen publishing (messages, editions) to
 * the newest ms they were seen.
 */
export function useMembers(
  community: Community | undefined,
  observed: Map<string, number>,
): { members: Set<string>; coalesced: Map<string, CoalescedMember> } {
  const { coalesced } = useGuestbook(community);
  const { data: folded } = useControlFold(community);
  const members = useMemo(
    () => completeMemberlist(coalesced, observed, folded?.banned ?? new Set(), folded?.bannedAt),
    [coalesced, observed, folded],
  );
  return { members, coalesced };
}

/** Publish one guestbook rumor to the community relays. */
export function useGuestbookPublisher(community: Community | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const { data: dissolvedNow } = useDissolved(community);

  return useMutation({
    mutationFn: async (
      action:
        | { type: "join"; attribution?: { creator: string; label?: string } }
        | { type: "leave" }
        | { type: "kick"; target: string; vac?: { eid: string; version: bigint; hash: string } },
    ) => {
      if (!user || !community) throw new Error("Not ready.");
      // A dissolved community honors no new authority action (CORD-02 §9). A
      // Leave stays open: it is self-signed housekeeping, not authority, and a
      // member must always be able to walk away from a grave.
      if (dissolvedNow != null && action.type === "kick") {
        throw new Error("This community has been dissolved; it accepts no new moderation.");
      }
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
        queryClient.invalidateQueries({ queryKey: ["concord", "guestbook", community.idHex] });
      }
    },
  });
}
