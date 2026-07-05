import { bytesToHex } from "@noble/hashes/utils.js";
import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { useDeferredFold } from "@/concord-v1/hooks/useDeferredFold";
import {
  buildGrantEditionUnsigned,
  buildRoleEditionUnsigned,
  controlPseudonym,
  dissolvedAddress,
  foldRoster,
  isDissolved,
  sealControlEdition,
  type FoldedRoster,
} from "@/concord-v1/lib/control";
import { KIND_COMMUNITY_CONTROL } from "@/concord-v1/lib/kinds";
import { adminRole, type MemberGrant, type Role } from "@/concord-v1/lib/roles";
import { grantLocator } from "@/concord-v1/lib/derive";
import { hex32, random32, type Community } from "@/concord-v1/lib/types";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

/** Merge two control-event sets by id (dedup), so a partial network round
 *  doesn't drop editions the cache/seed already held. */
function mergeById(a: NostrEvent[], b: NostrEvent[]): NostrEvent[] {
  const byId = new Map<string, NostrEvent>();
  for (const e of a) byId.set(e.id, e);
  for (const e of b) byId.set(e.id, e);
  return [...byId.values()];
}

/**
 * The relay filter selecting a community's control plane: sealed 3308
 * editions at the control `#z` pseudonym.
 */
function controlFilter(community: Community, limit = 500): NostrFilter {
  const z = controlPseudonym(community.serverRootKey, community.id, community.serverRootEpoch);
  return { kinds: [KIND_COMMUNITY_CONTROL], "#z": [z], limit };
}

/**
 * Fetch the community's control plane ONCE: the sealed kind-3308 editions at
 * the control pseudonym (`#z`), from every community relay. The roster,
 * metadata (GroupRoot/channels), and banlist are all folds of this SAME event
 * set — so they share this single fan-out instead of each re-querying the same
 * filter (which previously tripled the relay traffic AND chained `enabled`
 * gates into a serial waterfall on channel open). Folding is cheap, in-memory,
 * and done per-consumer with `useMemo`.
 *
 * Cache-first: the sealed 3308 editions are mirrored into IndexedDB by the
 * batcher, so on reload we read them back (by `#z`) and seed the query
 * immediately — roster/metadata/icon/banner/banlist paint from cache without
 * waiting on the network (which still runs and reconciles). Mirrors the
 * channel-message seed in `useConcordChannelMessages`.
 *
 * `active` gates the NETWORK fan-out (and the 30s poll), not the IndexedDB seed
 * or the persisted fold snapshot. The server rail renders one button per
 * community on every page and only needs the icon/name — served from the
 * persisted `metadata:` snapshot with no network. So the rail passes
 * `active = false`, and the open community's page passes `active = true`:
 * navigating INTO a community is what syncs its control plane, instead of
 * fanning out a per-relay 3308 query for every community on pageload. All
 * consumers share the `["concord","control",cid]` key, so the rail button for
 * the open community reuses the page's live query.
 */
export function useConcordControlEvents(community: Community | undefined, active = true) {
  const { nostr } = useNostr();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();

  const cidHex = community ? bytesToHex(community.id) : null;
  const queryKey = ["concord", "control", cidHex] as const;

  // Seed from the local store before the network resolves.
  useEffect(() => {
    if (!community) return;
    let cancelled = false;
    void (async () => {
      if ((queryClient.getQueryData<NostrEvent[]>(queryKey)?.length ?? 0) > 0) return;
      const store = await eventStore;
      const cached = await store.query([controlFilter(community)]);
      if (cancelled || cached.length === 0) return;
      queryClient.setQueryData<NostrEvent[]>(queryKey, (old) =>
        old && old.length > 0 ? old : cached,
      );
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cidHex, eventStore, queryClient]);

  return useQuery<NostrEvent[]>({
    queryKey,
    enabled: Boolean(community) && active,
    staleTime: 15_000,
    refetchInterval: active ? 30_000 : false,
    queryFn: async ({ signal }) => {
      const results = await Promise.all(
        community!.relays.map((url) =>
          nostr
            .relay(url)
            .query([controlFilter(community!)], {
              signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
            })
            .catch(() => [] as NostrEvent[]),
        ),
      );
      // Union with what we already have (seed/prior fetch): control editions are
      // append-only version chains, so a relay returning a partial page must
      // never drop editions we already hold — the fold picks the head per entity.
      const fetched = results.flat();
      const prev = queryClient.getQueryData<NostrEvent[]>(queryKey) ?? [];
      return mergeById(prev, fetched);
    },
  });
}

/**
 * Fetch + fold the control plane (kind-3308 editions) of a Concord community
 * into its authorized roster: roles, member grants, and the proven owner. This
 * is the data behind the member list, the admin crown, and every moderation
 * permission check. Folded client-side — no host asserts it.
 */
export function useConcordRoster(community: Community | undefined, active = true) {
  const control = useConcordControlEvents(community, active);
  const events = control.data;

  // Fold OFF the render path (deferred to after paint) so a large control plane
  // doesn't block the channel's first frame; the persisted snapshot paints
  // admin badges / member list meanwhile.
  const data = useDeferredFold<FoldedRoster>(
    community ? `roster:${bytesToHex(community.id)}` : null,
    () =>
      community && events
        ? foldRoster(events, community.serverRootKey, community.id, community.ownerAttestation)
        : undefined,
    [community, events],
  );

  return { ...control, events, data } as typeof control & {
    events: NostrEvent[] | undefined;
    data: FoldedRoster | undefined;
  };
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
export function useConcordDissolved(community: Community | undefined, active = true) {
  const { nostr } = useNostr();
  const roster = useConcordRoster(community, active);

  return useQuery<boolean>({
    queryKey: ["concord", "dissolved", community ? bytesToHex(community.id) : null],
    enabled: Boolean(community) && active && Boolean(roster.data?.ownerHex),
    staleTime: 30_000,
    refetchInterval: active ? 60_000 : false,
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

/**
 * Publish a control edition to the community's relays: sign the inner edition
 * with the actor's identity and seal it under the server root.
 */
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

/** The grant-entity locator. */
function grantLocatorFor(community: Community, memberHex: string): Uint8Array {
  return grantLocator(community.id, hex32(memberHex));
}

/** The unsigned Role edition. */
function roleEditionFor(_community: Community, opts: { role: Role; version: bigint; prevHash?: Uint8Array; createdAtSecs: number }) {
  return buildRoleEditionUnsigned(opts);
}

/** The unsigned Grant edition. */
function grantEditionFor(
  community: Community,
  opts: { grant: MemberGrant; version: bigint; prevHash?: Uint8Array; createdAtSecs: number },
) {
  return buildGrantEditionUnsigned({ communityId: community.id, ...opts });
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
    if (community) queryClient.invalidateQueries({ queryKey: ["concord", "control", bytesToHex(community.id)] });
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
        await publishControl(nostr, user, community, roleEditionFor(community, { role, version: 1n, createdAtSecs: now }));
      }

      // Build the member's next grant edition (version chained off the held head).
      const locatorKey = bytesToHex(grantLocatorFor(community, member));
      const head = roster.data?.heads.get(locatorKey);
      const grant: MemberGrant = { member, roleIds: admin ? [roleId] : [] };
      await publishControl(
        nostr,
        user,
        community,
        grantEditionFor(community, {
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
        roleEditionFor(community, {
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
      const key = bytesToHex(grantLocatorFor(community, member));
      const head = heads?.get(key);
      const grant: MemberGrant = { member, roleIds };
      await publishControl(
        nostr,
        user,
        community,
        grantEditionFor(community, {
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
