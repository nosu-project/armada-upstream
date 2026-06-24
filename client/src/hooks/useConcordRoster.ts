import { bytesToHex } from "@noble/hashes/utils.js";
import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import {
  buildGrantEditionUnsigned,
  buildRoleEditionUnsigned,
  controlPseudonym,
  dissolvedAddress,
  foldRoster,
  isDissolved,
  sealControlEdition,
  type FoldedRoster,
} from "@/lib/concord/control";
import { KIND_COMMUNITY_CONTROL } from "@/lib/concord/kinds";
import { adminRole, type MemberGrant, type Role } from "@/lib/concord/roles";
import { grantLocator } from "@/lib/concord/derive";
import { hex32, random32, type Community } from "@/lib/concord/types";

import type { NostrEvent } from "@nostrify/nostrify";

/**
 * Fetch + fold the control plane (kind-3308 editions) of a Concord community
 * into its authorized roster: roles, member grants, and the proven owner. This
 * is the data behind the member list, the admin crown, and every moderation
 * permission check. Folded client-side — no host asserts it.
 */
export function useConcordRoster(community: Community | undefined) {
  const { nostr } = useNostr();

  return useQuery<FoldedRoster>({
    queryKey: ["concord", "roster", community ? bytesToHex(community.id) : null],
    enabled: Boolean(community),
    staleTime: 15_000,
    refetchInterval: 30_000,
    queryFn: async ({ signal }) => {
      const z = controlPseudonym(community!.serverRootKey, community!.id, community!.serverRootEpoch);
      const results = await Promise.all(
        community!.relays.map((url) =>
          nostr
            .relay(url)
            .query([{ kinds: [KIND_COMMUNITY_CONTROL], "#z": [z], limit: 500 }], {
              signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
            })
            .catch(() => [] as NostrEvent[]),
        ),
      );
      return foldRoster(results.flat(), community!.serverRootKey, community!.id, community!.ownerAttestation);
    },
  });
}

/**
 * The member list: every pubkey that holds a grant, plus the owner, with their
 * highest role + admin flag. Built from the folded roster. (Concord has no
 * separate member roster — "members" are key-holders; the visible list is the
 * owner + everyone who's been granted a role. Plain key-holders with no role
 * aren't individually enumerable, by design.)
 */
export function concordMembers(roster: FoldedRoster): Array<{ pubkey: string; isOwner: boolean }> {
  const set = new Set<string>();
  if (roster.ownerHex) set.add(roster.ownerHex);
  for (const g of roster.roster.grants) set.add(g.member);
  return [...set].map((pubkey) => ({ pubkey, isOwner: pubkey === roster.ownerHex }));
}

/**
 * Whether a community has been dissolved by its owner (terminal). Reads the
 * epoch-free dissolved pseudonym and verifies an owner-signed vsk=10 tombstone.
 * Polled so a dissolution propagates to open clients.
 */
export function useConcordDissolved(community: Community | undefined) {
  const { nostr } = useNostr();
  const roster = useConcordRoster(community);

  return useQuery<boolean>({
    queryKey: ["concord", "dissolved", community ? bytesToHex(community.id) : null],
    enabled: Boolean(community) && Boolean(roster.data?.ownerHex),
    staleTime: 30_000,
    refetchInterval: 60_000,
    queryFn: async ({ signal }) => {
      const z = dissolvedAddress(community!.id);
      const results = await Promise.all(
        community!.relays.map((url) =>
          nostr
            .relay(url)
            .query([{ kinds: [KIND_COMMUNITY_CONTROL], "#z": [z], limit: 10 }], {
              signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
            })
            .catch(() => [] as NostrEvent[]),
        ),
      );
      return isDissolved(results.flat(), community!.id, roster.data!.ownerHex);
    },
  });
}

/** Publish a control edition (role or grant) to the community's relays. */
async function publishControl(
  nostr: ReturnType<typeof useNostr>["nostr"],
  user: NonNullable<ReturnType<typeof useCurrentUser>["user"]>,
  community: Community,
  unsigned: { kind: number; content: string; tags: string[][]; created_at: number },
): Promise<void> {
  const signedInner = await user.signer.signEvent(unsigned);
  const outer = sealControlEdition(signedInner, community.serverRootKey, community.id, community.serverRootEpoch);
  await Promise.all(
    community.relays.map((url) => nostr.relay(url).event(outer, { signal: AbortSignal.timeout(8000) }).catch(() => {})),
  );
}

/**
 * Roster mutations: ensure an Admin role exists, and grant/revoke it for a
 * member. The owner (or any MANAGE_ROLES holder who outranks the target) signs;
 * every member's fold re-verifies the delegation chain, so a forged grant is
 * dropped on every client.
 */
export function useConcordRosterActions(community: Community | undefined) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const queryClient = useQueryClient();

  const roster = useConcordRoster(community);

  const invalidate = () => {
    if (community) queryClient.invalidateQueries({ queryKey: ["concord", "roster", bytesToHex(community.id)] });
  };

  /** The Admin role id in the current roster, or undefined if none defined yet. */
  const adminRoleId = roster.data?.roster.roles.find((r) => r.name === "Admin")?.roleId;

  const setAdmin = useMutation<void, Error, { member: string; admin: boolean }>({
    mutationFn: async ({ member, admin }) => {
      if (!user || !community) throw new Error("Not ready.");
      const now = Math.floor(Date.now() / 1000);

      // Ensure an Admin role exists (mint + publish it if absent).
      let roleId = adminRoleId;
      if (!roleId) {
        const role = adminRole(bytesToHex(random32()));
        roleId = role.roleId;
        await publishControl(nostr, user, community, buildRoleEditionUnsigned({ role, version: 1n, createdAtSecs: now }));
      }

      // Build the member's next grant edition (version chained off the held head).
      const locatorKey = bytesToHex(grantLocator(community.id, hex32(member)));
      const head = roster.data?.heads.get(locatorKey);
      const grant: MemberGrant = { member, roleIds: admin ? [roleId] : [] };
      await publishControl(
        nostr,
        user,
        community,
        buildGrantEditionUnsigned({
          communityId: community.id,
          grant,
          version: head ? head.version + 1n : 1n,
          prevHash: head?.hash,
          createdAtSecs: now,
        }),
      );
    },
    onSuccess: invalidate,
  });

  /** Heads lookup for the role/grant version chains. */
  const heads = roster.data?.heads;

  /** Create or update a role (name, position, permissions, color). Version-chained. */
  const saveRole = useMutation<string, Error, { role: Role }>({
    mutationFn: async ({ role }) => {
      if (!user || !community) throw new Error("Not ready.");
      const now = Math.floor(Date.now() / 1000);
      const key = bytesToHex(hex32(role.roleId));
      const head = heads?.get(key);
      await publishControl(
        nostr,
        user,
        community,
        buildRoleEditionUnsigned({
          role,
          version: head ? head.version + 1n : 1n,
          prevHash: head?.hash,
          createdAtSecs: now,
        }),
      );
      return role.roleId;
    },
    onSuccess: invalidate,
  });

  /** Set a member's full role-id set directly (general grant, version-chained). */
  const setMemberRoles = useMutation<void, Error, { member: string; roleIds: string[] }>({
    mutationFn: async ({ member, roleIds }) => {
      if (!user || !community) throw new Error("Not ready.");
      const now = Math.floor(Date.now() / 1000);
      const key = bytesToHex(grantLocator(community.id, hex32(member)));
      const head = heads?.get(key);
      const grant: MemberGrant = { member, roleIds };
      await publishControl(
        nostr,
        user,
        community,
        buildGrantEditionUnsigned({
          communityId: community.id,
          grant,
          version: head ? head.version + 1n : 1n,
          prevHash: head?.hash,
          createdAtSecs: now,
        }),
      );
    },
    onSuccess: invalidate,
  });

  return {
    roster: roster.data,
    isLoading: roster.isLoading,
    setAdmin: setAdmin.mutateAsync,
    isSettingAdmin: setAdmin.isPending,
    saveRole: saveRole.mutateAsync,
    isSavingRole: saveRole.isPending,
    setMemberRoles: setMemberRoles.mutateAsync,
    isSettingRoles: setMemberRoles.isPending,
    /** A fresh random role id for minting a new role. */
    newRoleId: () => bytesToHex(random32()),
  };
}
