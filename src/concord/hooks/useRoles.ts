import { useNostr } from "@nostrify/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { useControlFold, citationFor, invalidateControl, publishEdition } from "@/concord/hooks/useControlPlane";
import { useUpdateCommunityList } from "@/concord/hooks/useCommunityList";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { buildGrantEdition, buildMetadataEdition, buildRoleEdition } from "@/concord/lib/control";
import { bytesToHex, controlSignerGroupKey, grantLocator, hex32, random32 } from "@/concord/lib/derive";
import { base64ToBytes, bytesToBase64, decodeControlWrap, encodeControlWrap } from "@/concord/lib/rekey";
import { adminRole, canActOnMember, canActOnPosition, emptyRoles, grantRefusal, moderatorRole, Permissions, rolesMakeStaff, STAFF_MASK, type MemberGrant, type Role } from "@/concord/lib/roles";
import type { CommunityMetadata, Community, ImagePointer } from "@/concord/lib/types";

/**
 * The `control_wrap` owed when a Grant leaves `member` staff (CORD-04 §3): the
 * current `control_root` NIP-44-encrypted granter↔member, plaintext
 * `epoch_be[8] ‖ control_root[32]`. `undefined` for a legacy epoch or non-staff
 * result. Attached on EVERY staff-leaving grant (re-issue is the spec's
 * re-delivery path). Throws if owed but unmintable — never seat a staffer who can't write.
 */
async function controlWrapOwed(
  community: Community,
  makesStaff: boolean,
  nip44: { encrypt(pubkey: string, plaintext: string): Promise<string> } | undefined,
  member: string,
): Promise<string | undefined> {
  if (!community.controlPk || !makesStaff) return undefined;
  if (!community.controlRoot) {
    // Unreachable today (publishing needs the same secret), but guard the promotion anyway.
    throw new Error("You don't hold this community's staff write key, so you can't promote to staff yet.");
  }
  if (!nip44) throw new Error("This signer can't deliver the staff write key (NIP-44 unsupported).");
  return await nip44.encrypt(
    member,
    bytesToBase64(encodeControlWrap(community.rootEpoch, community.controlRoot)),
  );
}

/**
 * Metadata mutations (vsk 0, MANAGE_METADATA), version-chained off the held
 * head. Unknown fields round-trip untouched (CORD-02 §6).
 */
export function useMetadataActions(community: Community | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const { data: folded } = useControlFold(community);

  const updateMetadata = useMutation<
    void,
    Error,
    { name?: string; description?: string; icon?: ImagePointer | null; banner?: ImagePointer | null; relays?: string[]; av_brokers?: string[]; message_expiration?: number }
  >({
    mutationFn: async (patch) => {
      if (!user || !community) throw new Error("Not ready.");
      const current: CommunityMetadata =
        folded?.metadata ?? ({ name: community.name, relays: community.relays } as CommunityMetadata);

      const next: CommunityMetadata = { ...current }; // round-trips unknown fields
      if (patch.name !== undefined) next.name = patch.name.trim();
      if (patch.description !== undefined) next.description = patch.description.trim() || undefined;
      if (patch.icon !== undefined) next.icon = patch.icon ?? undefined;
      if (patch.banner !== undefined) next.banner = patch.banner ?? undefined;
      if (patch.relays !== undefined) next.relays = patch.relays;
      // CORD-02 §6: "none" is the field's ABSENCE (members fall back to their own broker).
      if (patch.av_brokers !== undefined) {
        if (patch.av_brokers.length > 0) next.av_brokers = patch.av_brokers;
        else delete next.av_brokers;
      }
      // CORD-08: off is the field's ABSENCE.
      if (patch.message_expiration !== undefined) {
        if (patch.message_expiration > 0) next.message_expiration = Math.floor(patch.message_expiration);
        else delete next.message_expiration;
      }

      // Publish to old ∪ new relays so members still on the old ones see the move.
      const publishRelays =
        patch.relays !== undefined ? [...new Set([...community.relays, ...patch.relays])] : undefined;

      const head = folded?.heads.get(community.idHex);
      await publishEdition(
        nostr,
        community,
        user.signer,
        buildMetadataEdition(community.id, next, {
          actorPubkey: user.pubkey,
          version: head ? head.version + 1n : 1n,
          prevHash: head?.hash,
          authority: citationFor(community, folded, user.pubkey),
        }),
        publishRelays ? { relays: publishRelays } : undefined,
      );
      invalidateControl(queryClient, community.idHex);
    },
  });

  return {
    metadata: folded?.metadata,
    updateMetadata: updateMetadata.mutateAsync,
    isUpdating: updateMetadata.isPending,
  };
}

/**
 * Roster mutations (vsk 1 Roles + vsk 3 Grants, MANAGE_ROLES); every fold
 * re-verifies the owner-rooted delegation chain.
 */
export function useRoles(community: Community | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const { data: folded, isLoading } = useControlFold(community);

  const invalidate = () => {
    if (community) invalidateControl(queryClient, community.idHex);
  };

  const grantHeadOf = (member: string) =>
    community ? folded?.heads.get(bytesToHex(grantLocator(community.id, hex32(member)))) : undefined;

  const adminRoleId = folded?.roster.roles.find((r) => r.name === "Admin")?.roleId;
  const moderatorRoleId = folded?.roster.roles.find((r) => r.name === "Moderator")?.roleId;

  const saveRole = useMutation<string, Error, { role: Role }>({
    mutationFn: async ({ role }) => {
      if (!user || !community) throw new Error("Not ready.");
      const head = folded?.heads.get(role.roleId);
      await publishEdition(
        nostr,
        community,
        user.signer,
        buildRoleEdition(role, {
          actorPubkey: user.pubkey,
          version: head ? head.version + 1n : 1n,
          prevHash: head?.hash,
          authority: citationFor(community, folded, user.pubkey),
        }),
      );
      return role.roleId;
    },
    onSuccess: invalidate,
  });

  const setMemberRoles = useMutation<void, Error, { member: string; roleIds: string[] }>({
    mutationFn: async ({ member, roleIds }) => {
      if (!user || !community) throw new Error("Not ready.");
      // The fold's gate (CORD-04 §2/§3), checked before publishing so a doomed grant
      // fails with a reason instead of being silently dropped.
      const ownerHex = folded?.ownerHex ?? community.owner;
      const refusal = grantRefusal(folded?.roster ?? emptyRoles(), user.pubkey, ownerHex, member, roleIds);
      if (refusal) throw new Error(refusal);
      const head = grantHeadOf(member);
      // A staff-making grant carries the staff write key itself (CORD-04 §3).
      const controlWrap = await controlWrapOwed(
        community,
        rolesMakeStaff(folded?.roster ?? emptyRoles(), roleIds),
        user.signer.nip44,
        member,
      );
      const grant: MemberGrant = { member, roleIds, ...(controlWrap ? { controlWrap } : {}) };
      await publishEdition(
        nostr,
        community,
        user.signer,
        buildGrantEdition(community.id, grant, {
          actorPubkey: user.pubkey,
          version: head ? head.version + 1n : 1n,
          prevHash: head?.hash,
          authority: citationFor(community, folded, user.pubkey),
        }),
      );
    },
    onSuccess: invalidate,
  });

  /**
   * Set a member's stock tier: "admin" (position 1, owner-grantable only),
   * "moderator" (position 2, any strict outranker with MANAGE_ROLES), or null
   * (revoke). Pre-checks the fold's authority rules (CORD-04 §3).
   */
  const setTier = useMutation<void, Error, { member: string; tier: "admin" | "moderator" | null }>({
    mutationFn: async ({ member, tier }) => {
      if (!user || !community) throw new Error("Not ready.");
      const ownerHex = folded?.ownerHex ?? community.owner;
      const roster = folded?.roster ?? emptyRoles();

      // Strict outrank over the member, and over the granted role's position.
      if (!canActOnMember(roster, user.pubkey, ownerHex, member, Permissions.MANAGE_ROLES)) {
        throw new Error("You don't outrank this member.");
      }
      const minted = tier === "admin" ? adminRole(bytesToHex(random32())) : tier === "moderator" ? moderatorRole(bytesToHex(random32())) : undefined;
      if (minted && !canActOnPosition(roster, user.pubkey, ownerHex, minted.position, Permissions.MANAGE_ROLES)) {
        throw new Error(tier === "admin" ? "Only the owner can grant Admin." : "You can't grant a role at this rank.");
      }

      let roleId: string | undefined;
      if (minted) {
        roleId = tier === "admin" ? adminRoleId : moderatorRoleId;
        if (!roleId) {
          roleId = minted.roleId;
          await publishEdition(
            nostr,
            community,
            user.signer,
            buildRoleEdition(minted, {
              actorPubkey: user.pubkey,
              version: 1n,
              authority: citationFor(community, folded, user.pubkey),
            }),
          );
        }
      }

      // Only the stock Admin/Moderator roles swap; custom roles ride along.
      const stock = new Set([adminRoleId, moderatorRoleId].filter((id): id is string => Boolean(id)));
      const kept = (roster.grants.find((g) => g.member === member)?.roleIds ?? []).filter((id) => !stock.has(id));
      const head = grantHeadOf(member);
      // Both stock tiers hold Control-writing bits, so promotion is always
      // staff-making (judged from the tier's bits; the roster may lag). A null tier
      // can still leave the member staff via a kept custom role.
      const makesStaff =
        (minted !== undefined && (minted.permissions & STAFF_MASK) !== 0n) ||
        rolesMakeStaff(roster, kept);
      const controlWrap = await controlWrapOwed(community, makesStaff, user.signer.nip44, member);
      const grant: MemberGrant = {
        member,
        roleIds: roleId ? [...kept, roleId] : kept,
        ...(controlWrap ? { controlWrap } : {}),
      };
      await publishEdition(
        nostr,
        community,
        user.signer,
        buildGrantEdition(community.id, grant, {
          actorPubkey: user.pubkey,
          version: head ? head.version + 1n : 1n,
          prevHash: head?.hash,
          authority: citationFor(community, folded, user.pubkey),
        }),
      );
    },
    onSuccess: invalidate,
  });

  return {
    folded,
    isLoading,
    setTier: setTier.mutateAsync,
    isSettingTier: setTier.isPending,
    saveRole: saveRole.mutateAsync,
    isSavingRole: saveRole.isPending,
    setMemberRoles: setMemberRoles.mutateAsync,
    isSettingRoles: setMemberRoles.isPending,
    newRoleId: () => bytesToHex(random32()),
  };
}

/**
 * Adopt the staff write key delivered in my own Grant (CORD-04 §3). Decrypts the
 * folded head's `control_wrap` when I don't already hold the secret, adopting
 * only if its epoch is mine and it derives to my `control_pk` (CORD-02 §5).
 * Stale wraps are normal (compaction re-wraps heads across Refoundings).
 * Success is recorded in the Community List vault, reaching other devices.
 */
export function useStaffKeyWatch(community: Community | undefined): void {
  const { user } = useCurrentUser();
  const { data: folded } = useControlFold(community);
  const { mutateAsync: updateList } = useUpdateCommunityList();
  const queryClient = useQueryClient();
  // One attempt per (grant edition, epoch) per session; failures are deterministic.
  const attempted = useRef(new Set<string>());

  useEffect(() => {
    if (!community || !user || !folded) return;
    // Legacy epoch (no write key), or secret already held and verified.
    if (!community.controlPk || community.controlRoot) return;
    const nip44 = user.signer.nip44;
    if (!nip44) return;

    const eidHex = bytesToHex(grantLocator(community.id, hex32(user.pubkey)));
    const head = folded.headEditions.get(eidHex);
    if (!head) return;
    const grant = folded.roster.grants.find((g) => g.member === user.pubkey);
    if (!grant?.controlWrap) return;

    const key = `${bytesToHex(head.rumorId)}:${community.rootEpoch}`;
    if (attempted.current.has(key)) return;
    attempted.current.add(key);

    let cancelled = false;
    void (async () => {
      let controlRoot: Uint8Array;
      try {
        // The granter is the head's sealed author (the pairwise key's other half).
        const plain = base64ToBytes(await nip44.decrypt(head.author, grant.controlWrap!));
        const decoded = decodeControlWrap(plain);
        // The epoch rides inside the ciphertext.
        if (decoded.epoch !== community.rootEpoch) return;
        if (controlSignerGroupKey(decoded.controlRoot, community.id, decoded.epoch).pk !== community.controlPk) return;
        controlRoot = decoded.controlRoot;
      } catch {
        return; // undecryptable / malformed — attributable griefing, nothing worse
      }
      if (cancelled) return;
      await updateList({
        type: "set-control-root",
        communityId: community.idHex,
        epoch: Number(community.rootEpoch),
        controlRootHex: bytesToHex(controlRoot),
      }).catch(() => {
        // The list write never landed; let a later fold retry.
        attempted.current.delete(key);
      });
      queryClient.invalidateQueries({ queryKey: ["concord", "list"] });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [community?.idHex, community?.rootEpoch, community?.controlPk, Boolean(community?.controlRoot), user?.pubkey, folded]);
}
