import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

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
import { mergeOpened, openPlaneWraps, sweepGuestbook } from "@/concord/lib/planeSync";
import { queryPlane, writeOpened } from "@/concord/lib/rumorStore";
import type { OpenedEvent } from "@/concord/lib/stream";
import { citationSatisfied } from "@/concord/lib/control";
import { canActOnMember, Permissions } from "@/concord/lib/roles";
import type { Community } from "@/concord/lib/types";
import { emitWireScopes, onWireScopes } from "@/wire/bus";

/**
 * The Guestbook Plane (CORD-02 §5): membership motion, coalesced flat.
 * Off-consensus, so it polls lazily. Fetch/decrypt/cursor via
 * {@link sweepGuestbook}; wraps decrypted once into the opened-event cache.
 *
 * The poll is the FLOOR, not the delivery path. Live guestbook wraps arrive
 * through the wire's standing `c2gb` subscription (wire/spec.ts +
 * wire/ingest.ts), which decrypts them into the opened-event store and rings
 * `c2gb:<idHex>`; the effect below re-reads on that bus. That matters most for
 * a KICK, which rotates no key and publishes no control edition — so before the
 * live sub existed, the earliest a kicked member could learn of their own
 * removal was this query's 60s tick.
 */
export function useGuestbook(community: Community | undefined) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const { data: folded } = useControlFold(community);
  const { data: dissolvedAtMs } = useDissolved(community);

  const queryKey = useMemo(
    () => ["concord", "guestbook", community?.idHex ?? null, community?.rootEpoch.toString() ?? ""] as const,
    [community?.idHex, community?.rootEpoch],
  );

  const query = useQuery<OpenedEvent[]>({
    queryKey,
    enabled: Boolean(community),
    staleTime: 30_000,
    refetchInterval: 60_000,
    queryFn: async () => {
      // Read the STORE and return it; run the network sweep in the BACKGROUND,
      // merging its fresh events into the cache via onFresh — exactly as
      // useControlEvents keeps its query a pure store read with the sweep on a
      // separate effect. Awaiting the sweep here stranded every read (including
      // useSelfRemove's confirming refetch) behind a relay round-trip — up to
      // the auth gate (8s) plus the query timeout (25s) — which is the ~20s a
      // KICK took to actually remove the kickee AFTER their member list had
      // already flipped. The live c2gb sub (and, for our own actions, the
      // publisher's local seed) feed the store, so a background sweep loses no
      // freshness a blocking one had.
      const stored = await queryPlane(community!.idHex, "guestbook");
      const merged = mergeOpened(queryClient.getQueryData<OpenedEvent[]>(queryKey) ?? [], stored);
      void sweepGuestbook(nostr, community!, {
        onFresh: (fresh) => {
          if (fresh.length === 0) return;
          queryClient.setQueryData<OpenedEvent[]>(queryKey, (old) => mergeOpened(old ?? [], fresh));
        },
      }).catch(() => {
        // Best-effort: the live sub and the 5-minute background sweep cover a miss.
      });
      return merged;
    },
  });

  // The wire (or this client's own publish) wrote fresh guestbook rumors into
  // the store and rang `c2gb:<idHex>` — re-read them. This is a STORE-ONLY read
  // merged straight into the query cache, exactly like useControlEvents' c2ctl
  // wake: NOT an invalidate, because the query's queryFn awaits a network
  // sweepGuestbook FIRST, which would strand the already-stored kick behind a
  // live round-trip (NIP-42 auth + the sweep's 25s timeout + single-flight).
  // That is what made a kick take until the 60s poll to land on both sides.
  const idHex = community?.idHex;
  useEffect(() => {
    if (!idHex) return;
    const scope = `c2gb:${idHex}`;
    return onWireScopes((scopes) => {
      if (!scopes.has(scope)) return;
      void queryPlane(idHex, "guestbook").then((stored) => {
        if (stored.length === 0) return;
        queryClient.setQueryData<OpenedEvent[]>(queryKey, (old) => mergeOpened(old ?? [], stored));
      });
    });
  }, [idHex, queryKey, queryClient]);

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
      // Seed the store with our OWN just-published rumor, exactly as the wire's
      // ingest does for a received one, then ring `c2gb`. Otherwise the actor's
      // view only reflects the action once a network sweep reads it back off a
      // relay — the kicker-side half of the "kick takes a minute" bug, since
      // the publisher holds no standing echo of its own wrap.
      const opened = openPlaneWraps([wrap], [group]);
      if (opened.length > 0) await writeOpened(community.idHex, opened, "guestbook");
    },
    onSuccess: () => {
      // Store-only re-read on every mounted useGuestbook (see its c2gb wake),
      // NOT an invalidate — an invalidate awaits the network sweep first.
      if (community) emitWireScopes([`c2gb:${community.idHex}`]);
    },
  });
}
