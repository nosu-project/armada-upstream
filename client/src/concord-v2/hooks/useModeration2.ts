import { useNostr } from "@nostrify/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useControlFold2, citationFor, invalidateControl2, publishEdition2 } from "@/concord-v2/hooks/useControlPlane2";
import { useGuestbookPublisher2 } from "@/concord-v2/hooks/useGuestbook2";
import { useRefound2 } from "@/concord-v2/hooks/useRekey2";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { buildBanlistEdition, buildGrantEdition } from "@/concord-v2/lib/control";
import { banlistLocator, bytesToHex, grantLocator, hex32 } from "@/concord-v2/lib/derive";
import { canActOnMember, Permissions } from "@/concord-v2/lib/roles";
import type { CommunityV2 } from "@/concord-v2/lib/types";

/**
 * The Three Removals, composed in the order their guarantees arrive
 * (CORD-04 §6):
 *
 *   - KICK: Role Removal (grant strip) then the cooperative Guestbook
 *     directive — polite, unenforced, re-joinable.
 *   - BAN: the Banlist edition FIRST (silencing is instant and free), the
 *     grant strip alongside, the Refounding LAST (severance is heavy and
 *     asynchronous; it propagates while the target is already silenced).
 *   - UNBAN: a Banlist edition dropping the npub (access needs a re-invite —
 *     the rotation is one-way).
 *
 * `recipients` is who should KEEP access after a ban's Refounding.
 */
export function useModeration2(community: CommunityV2 | undefined, recipients: string[]) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const { data: folded } = useControlFold2(community);
  const guestbook = useGuestbookPublisher2(community);
  const { refound, canRefound } = useRefound2(community);

  const canActOn = (target: string, permission: bigint): boolean =>
    Boolean(user && folded && canActOnMember(folded.roster, user.pubkey, folded.ownerHex, target, permission));

  const invalidate = () => {
    if (community) {
      invalidateControl2(queryClient, community.idHex);
      queryClient.invalidateQueries({ queryKey: ["concord2", "guestbook", community.idHex] });
    }
  };

  /** Publish the whole banlist, replaced entire, chained off the held head. */
  const publishBanlist = async (banned: string[]) => {
    if (!user || !community) throw new Error("Not ready.");
    const head = folded?.heads.get(bytesToHex(banlistLocator(community.id)));
    await publishEdition2(
      nostr,
      community,
      user.signer,
      buildBanlistEdition(community.id, banned, {
        actorPubkey: user.pubkey,
        version: head ? head.version + 1n : 1n,
        prevHash: head?.hash,
        authority: citationFor(community, folded, user.pubkey),
      }),
    );
  };

  /** Strip every role from a member (Role Removal). Best-effort. */
  const stripRoles = async (target: string) => {
    if (!user || !community) return;
    const hasGrant = folded?.roster.grants.some((g) => g.member === target && g.roleIds.length > 0);
    if (!hasGrant) return;
    const head = folded?.heads.get(bytesToHex(grantLocator(community.id, hex32(target))));
    await publishEdition2(
      nostr,
      community,
      user.signer,
      buildGrantEdition(
        community.id,
        { member: target, roleIds: [] },
        {
          actorPubkey: user.pubkey,
          version: head ? head.version + 1n : 1n,
          prevHash: head?.hash,
          authority: citationFor(community, folded, user.pubkey),
        },
      ),
    ).catch(() => undefined);
  };

  const ban = useMutation<{ rekeyed: boolean }, Error, { target: string }>({
    mutationFn: async ({ target }) => {
      if (!user || !community) throw new Error("Not ready.");
      if (!canActOn(target, Permissions.BAN)) throw new Error("You don't have permission to ban this member.");

      // 1. Banlist first: silencing is instant and free.
      const next = new Set(folded?.banned ?? []);
      next.add(target);
      await publishBanlist([...next]);

      // 2. Role removal alongside.
      await stripRoles(target);

      // 3. The Refounding last: the cryptographic severance.
      if (!canRefound) return { rekeyed: false };
      try {
        await refound({ keep: recipients.filter((pk) => pk !== target), exclude: [target] });
        return { rekeyed: true };
      } catch {
        return { rekeyed: false };
      }
    },
    onSuccess: invalidate,
  });

  const unban = useMutation<void, Error, { target: string }>({
    mutationFn: async ({ target }) => {
      if (!canActOn(target, Permissions.BAN)) throw new Error("You don't have permission.");
      const next = new Set(folded?.banned ?? []);
      next.delete(target);
      await publishBanlist([...next]);
    },
    onSuccess: invalidate,
  });

  const kick = useMutation<void, Error, { target: string }>({
    mutationFn: async ({ target }) => {
      if (!community || !user) throw new Error("Not ready.");
      if (!canActOn(target, Permissions.KICK)) throw new Error("You don't have permission to kick this member.");
      // Strip first, so the target's rank is gone before the departure lands.
      await stripRoles(target);
      const citation = citationFor(community, folded, user.pubkey);
      await guestbook.mutateAsync({
        type: "kick",
        target,
        vac: citation
          ? { eid: bytesToHex(citation.entityId), version: citation.version, hash: bytesToHex(citation.editionHash) }
          : undefined,
      });
    },
    onSuccess: invalidate,
  });

  return {
    banned: folded?.banned ?? new Set<string>(),
    canRekey: canRefound,
    ban: ban.mutateAsync,
    isBanning: ban.isPending,
    unban: unban.mutateAsync,
    kick: kick.mutateAsync,
    isKicking: kick.isPending,
    canBan: (target: string) => canActOn(target, Permissions.BAN),
    canKick: (target: string) => canActOn(target, Permissions.KICK),
  };
}
