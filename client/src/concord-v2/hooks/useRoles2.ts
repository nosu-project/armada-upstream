import { useNostr } from "@nostrify/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useControlFold2, citationFor, invalidateControl2, publishEdition2 } from "@/concord-v2/hooks/useControlPlane2";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { buildGrantEdition, buildMetadataEdition, buildRoleEdition } from "@/concord-v2/lib/control";
import { bytesToHex, grantLocator, hex32, random32 } from "@/concord-v2/lib/derive";
import { adminRole, type MemberGrant, type Role } from "@/concord-v2/lib/roles";
import type { CommunityMetadata, CommunityV2, ImagePointer } from "@/concord-v2/lib/types";

/**
 * Metadata mutations (vsk 0, MANAGE_METADATA): edit name / description /
 * icon / banner / relays, version-chained off the held head. Unknown fields
 * (`custom`, vendor extensions) round-trip untouched (CORD-02 §6).
 */
export function useMetadataActions2(community: CommunityV2 | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const { data: folded } = useControlFold2(community);

  const updateMetadata = useMutation<
    void,
    Error,
    { name?: string; description?: string; icon?: ImagePointer | null; banner?: ImagePointer | null; relays?: string[] }
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

      const head = folded?.heads.get(community.idHex);
      await publishEdition2(
        nostr,
        community,
        user.signer,
        buildMetadataEdition(community.id, next, {
          actorPubkey: user.pubkey,
          version: head ? head.version + 1n : 1n,
          prevHash: head?.hash,
          authority: citationFor(community, folded, user.pubkey),
        }),
      );
      invalidateControl2(queryClient, community.idHex);
    },
  });

  return {
    metadata: folded?.metadata,
    updateMetadata: updateMetadata.mutateAsync,
    isUpdating: updateMetadata.isPending,
  };
}

/**
 * Roster mutations (vsk 1 Roles + vsk 3 Grants, MANAGE_ROLES): every member's
 * fold re-verifies the owner-rooted delegation chain, so a forged grant is
 * dropped network-wide.
 */
export function useRoles2(community: CommunityV2 | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();
  const { data: folded, isLoading } = useControlFold2(community);

  const invalidate = () => {
    if (community) invalidateControl2(queryClient, community.idHex);
  };

  const grantHeadOf = (member: string) =>
    community ? folded?.heads.get(bytesToHex(grantLocator(community.id, hex32(member)))) : undefined;

  /** The stock Admin role id in the current roster, if one exists. */
  const adminRoleId = folded?.roster.roles.find((r) => r.name === "Admin")?.roleId;

  const saveRole = useMutation<string, Error, { role: Role }>({
    mutationFn: async ({ role }) => {
      if (!user || !community) throw new Error("Not ready.");
      const head = folded?.heads.get(role.roleId);
      await publishEdition2(
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
      const head = grantHeadOf(member);
      const grant: MemberGrant = { member, roleIds };
      await publishEdition2(
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

  const setAdmin = useMutation<void, Error, { member: string; admin: boolean }>({
    mutationFn: async ({ member, admin }) => {
      if (!user || !community) throw new Error("Not ready.");

      // Ensure the stock Admin role exists (mint + publish if absent).
      let roleId = adminRoleId;
      if (!roleId && admin) {
        const role = adminRole(bytesToHex(random32()));
        roleId = role.roleId;
        await publishEdition2(
          nostr,
          community,
          user.signer,
          buildRoleEdition(role, {
            actorPubkey: user.pubkey,
            version: 1n,
            authority: citationFor(community, folded, user.pubkey),
          }),
        );
      }

      const head = grantHeadOf(member);
      const grant: MemberGrant = { member, roleIds: admin && roleId ? [roleId] : [] };
      await publishEdition2(
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
    setAdmin: setAdmin.mutateAsync,
    isSettingAdmin: setAdmin.isPending,
    saveRole: saveRole.mutateAsync,
    isSavingRole: saveRole.isPending,
    setMemberRoles: setMemberRoles.mutateAsync,
    isSettingRoles: setMemberRoles.isPending,
    newRoleId: () => bytesToHex(random32()),
  };
}
