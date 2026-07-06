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
import { KIND_WRAP } from "@/concord-v2/lib/kinds";
import { queryByStreams, readStreamCursor, updateStreamCursor, writeOpened } from "@/concord-v2/lib/rumorStore";
import { openWrap, type OpenedEvent } from "@/concord-v2/lib/stream";
import { canActOnMember, Permissions } from "@/concord-v2/lib/roles";
import type { GroupKey } from "@/concord-v2/lib/derive";
import type { CommunityV2 } from "@/concord-v2/lib/types";

import type { NostrEvent } from "@nostrify/nostrify";

/** The persisted per-community guestbook sync cursor scope. */
const guestbookCursorScope = (idHex: string) => `guestbook:${idHex}`;

/** Decrypt raw guestbook wraps under the held groups into opened events. */
function openGuestbookRaw(wraps: NostrEvent[], groups: GroupKey[]): OpenedEvent[] {
  const byPk = new Map(groups.map((g) => [g.pk, g]));
  const out: OpenedEvent[] = [];
  for (const wrap of wraps) {
    const group = byPk.get(wrap.pubkey);
    if (!group) continue;
    try {
      out.push(openWrap(wrap, group));
    } catch {
      // not ours / malformed
    }
  }
  return out;
}

/**
 * The Guestbook Plane (CORD-02 §5): membership motion, coalesced flat. It's
 * off-consensus — nothing gates on it — so it polls lazily and lags without
 * harm. `observed` (author → newest ms seen publishing) merges in observably-
 * present authors; the Banlist subtracts.
 *
 * Wraps are never persisted: incoming kind-1059 guestbook wraps are decrypted
 * once into the opened-event cache (keyed by the guestbook stream address) and
 * read back with a `#stream` query; a persisted `since` cursor means motions
 * already seen are never refetched.
 */
export function useGuestbook2(community: CommunityV2 | undefined) {
  const { nostr } = useNostr();
  const { data: folded } = useControlFold2(community);

  const query = useQuery<OpenedEvent[]>({
    queryKey: ["concord2", "guestbook", community?.idHex ?? null, community?.rootEpoch.toString() ?? ""],
    enabled: Boolean(community),
    staleTime: 30_000,
    refetchInterval: 60_000,
    queryFn: async ({ signal }) => {
      const groups = guestbookGroups(community!);
      const scope = guestbookCursorScope(community!.idHex);
      const cursor = await readStreamCursor(scope);
      const filter: { kinds: number[]; authors: string[]; limit: number; since?: number } = {
        kinds: [KIND_WRAP],
        authors: groups.map((g) => g.pk),
        limit: 500,
      };
      if (cursor?.newest) filter.since = cursor.newest;

      const results = await Promise.all(
        community!.relays.map((url) =>
          nostr
            .relay(url)
            .query([filter], { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) })
            .catch(() => [] as NostrEvent[]),
        ),
      );
      const fresh = openGuestbookRaw(results.flat(), groups);
      if (fresh.length > 0) {
        writeOpened(fresh);
        await updateStreamCursor(scope, { newest: Math.max(...fresh.map((e) => e.createdAt)) });
      }
      const stored = await queryByStreams(groups.map((g) => g.pk));
      const byId = new Map<string, OpenedEvent>();
      for (const e of stored) byId.set(e.rumorId, e);
      for (const e of fresh) byId.set(e.rumorId, e);
      return [...byId.values()];
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
