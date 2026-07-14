import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";

import { useDeferredFold } from "@/concord-v2/hooks/useDeferredFold2";
import {
  controlGroups,
  currentControlGroup,
  foldControlState,
  isDissolvedOpened,
  openControlEditions,
  sealEdition,
  type EntityHead,
  type FoldedControl,
} from "@/concord-v2/lib/control";
import { channelsView } from "@/concord-v2/lib/community";
import { bytesToHex, dissolvedGroupKey, grantLocator, hex32 } from "@/concord-v2/lib/derive";
import type { AuthorityCitation } from "@/concord-v2/lib/edition";
import { KIND_WRAP } from "@/concord-v2/lib/kinds";
import { openPlaneWraps, mergeOpened, sweepControl } from "@/concord-v2/lib/planeSync";
import { queryByStreams, writeOpened, peekPendingWraps, ackPendingWraps } from "@/concord-v2/lib/rumorStore";
import { openWrap, type OpenedEvent, type Rumor, type StreamSigner } from "@/concord-v2/lib/stream";
import type { ChannelV2, CommunityV2 } from "@/concord-v2/lib/types";
import { logSync } from "@/lib/syncLog";
import { onWireScopes } from "@/wire/bus";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

/**
 * The persisted control-fold snapshot key for a community (see
 * {@link useDeferredFold}). Shared with the notification-subscription builder,
 * which reads the cached fold without mounting a per-community hook.
 */
export const controlFoldKey = (idHex: string) => `concord2-fold:${idHex}`;

/** The relay filter selecting a community's control plane across held epochs. */
function controlFilter(community: CommunityV2, limit = 500): NostrFilter {
  return { kinds: [KIND_WRAP], authors: controlGroups(community).map((g) => g.pk), limit };
}

/**
 * Fetch the community's Control Plane. Wraps are decrypted once into the
 * opened-event store; this query reads back from it with no decrypt. A
 * persisted `since` cursor means editions already seen are never refetched.
 * `active` gates the network fetch, not the local read.
 */
export function useControlEvents2(community: CommunityV2 | undefined, active = true) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();

  const cidHex = community?.idHex ?? null;
  const epochSig = community?.heldRoots.map((r) => r.epoch.toString()).join(",") ?? "";
  const queryKey = ["concord2", "control", cidHex, epochSig] as const;

  // Seed from the opened-event cache (paints rail icons without network).
  // Re-seeds on the `c2ctl:<id>` wire bus when the background sweep stores
  // new editions — a rail button with active=false can't be reached by
  // invalidation, so the bus is its only wake-up.
  useEffect(() => {
    if (!community) return;
    let cancelled = false;
    const seed = async (merge: boolean) => {
      if (!merge && (queryClient.getQueryData<OpenedEvent[]>(queryKey)?.length ?? 0) > 0) return;
      const cached = await queryByStreams(controlGroups(community).map((g) => g.pk));
      if (cancelled) return;
      logSync(
        "control",
        `${community.idHex.slice(0, 8)} store seed${merge ? " (bus re-seed)" : ""}: ${cached.length} opened edition(s)`,
      );
      if (cached.length === 0) return;
      queryClient.setQueryData<OpenedEvent[]>(queryKey, (old) =>
        merge ? mergeOpened(old ?? [], cached) : old && old.length > 0 ? old : cached,
      );
    };
    void seed(false);
    const scope = `c2ctl:${community.idHex}`;
    const unsubscribe = onWireScopes((scopes) => {
      if (scopes.has(scope)) void seed(true);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cidHex, epochSig, queryClient]);

  // Live subscription (open community only). Live events do NOT advance
  // any cursor — cursors only advance from relay query results (issue #19).
  useEffect(() => {
    if (!community || !active) return;
    const controller = new AbortController();
    const groups = controlGroups(community);
    const since = Math.floor(Date.now() / 1000);
    const { limit: _limit, ...base } = controlFilter(community);
    const filter = { ...base, since };
    for (const url of community.relays) {
      void (async () => {
        try {
          for await (const msg of nostr.relay(url).req([filter], {
            signal: controller.signal,
          })) {
            if (msg[0] === "EVENT") {
              const opened = openPlaneWraps([msg[2] as NostrEvent], groups);
              if (opened.length === 0) continue;
              writeOpened(opened);
              queryClient.setQueryData<OpenedEvent[]>(queryKey, (old) => mergeOpened(old ?? [], opened));
            }
          }
        } catch {
          // Subscription ended — the poll covers gaps.
        }
      })();
    }
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nostr, cidHex, epochSig, active, queryClient]);

  return useQuery<OpenedEvent[]>({
    queryKey,
    enabled: Boolean(community) && active,
    staleTime: 15_000,
    // The live `req` is the primary path; this poll is a gap-filler.
    refetchInterval: active ? 5 * 60_000 : false,
    refetchIntervalInBackground: false,
    queryFn: async () => {
      const groups = controlGroups(community!);
      // Drain wraps the native service parked (it can't decrypt).
      const parked = await peekPendingWraps(groups.map((g) => g.pk));
      if (parked.length > 0) {
        const opened = openPlaneWraps(parked, groups);
        writeOpened(opened);
        // Only ack wraps that decoded; the rest stay parked for a retry.
        const openedWrapIds = new Set(opened.map((o) => o.wrapId));
        ackPendingWraps(parked.filter((w) => openedWrapIds.has(w.id)).map((w) => w.id));
      }
      // Fetch via the shared plane-sweep discipline (per-relay cursors,
      // auth-gated, coalesced with the global sweep).
      const fresh = await sweepControl(nostr, community!);
      const stored = await queryByStreams(groups.map((g) => g.pk));
      const prev = queryClient.getQueryData<OpenedEvent[]>(queryKey) ?? [];
      return mergeOpened(prev, stored, fresh);
    },
  });
}

/**
 * The Control Plane replayed into current state (roster, metadata, channels,
 * banlist, registries). Folded off the render path with a persisted snapshot.
 */
export function useControlFold2(community: CommunityV2 | undefined, active = true) {
  const control = useControlEvents2(community, active);
  const events = control.data;

  // Per-entity high-water floor (CORD-04 §1): the highest version we've ever
  // accepted for each entity, monotonic and never lowered. Feeding it back into
  // the fold makes a tracking client fail closed on a withheld-middle chain —
  // a hostile relay serving only a higher DANGLING edition can't downgrade an
  // entity we already advanced past. Keyed per community; reset on switch.
  const floorRef = useRef<{ idHex: string; heads: Map<string, EntityHead> }>({ idHex: "", heads: new Map() });
  if (community && floorRef.current.idHex !== community.idHex) {
    floorRef.current = { idHex: community.idHex, heads: new Map() };
  }

  const data = useDeferredFold<FoldedControl>(
    community ? controlFoldKey(community.idHex) : null,
    () => {
      if (!community || !events) return undefined;
      const editions = openControlEditions(events);
      const folded = foldControlState(editions, community.id, community.owner, floorRef.current.heads);
      // Raise the high-water floor from this fold's accepted heads (upward only).
      for (const [eid, head] of folded.heads) {
        const prior = floorRef.current.heads.get(eid);
        if (!prior || head.version > prior.version) floorRef.current.heads.set(eid, head);
      }
      logSync(
        "fold",
        `${community.idHex.slice(0, 8)}: ${events.length} opened → ${editions.length} edition(s); name=${folded.metadata?.name ?? "∅"} icon=${folded.metadata?.icon ? "yes" : "no"} channels=${folded.channels.size} banned=${folded.banned.size} heads=${folded.heads.size}`,
      );
      return folded;
    },
    [community, events],
  );

  return { ...control, data } as typeof control & { data: FoldedControl | undefined };
}

/** The channels the member can read, assembled from the fold + held keys. */
export function useChannels2(community: CommunityV2 | undefined, active = true): ChannelV2[] {
  const { data: folded } = useControlFold2(community, active);
  return useMemo(() => (community ? channelsView(community, folded) : []), [community, folded]);
}

/**
 * Whether the community has been dissolved by its owner (terminal). Reads the
 * community-id-derived dissolved address — no key, no epoch — so every member
 * past or present resolves the same grave.
 *
 * `active` gates the network poll: the rail doesn't need each community's
 * dissolution status up-front, so it's only checked once you open the community.
 */
export function useDissolved2(community: CommunityV2 | undefined, active = true) {
  const { nostr } = useNostr();

  return useQuery<boolean>({
    queryKey: ["concord2", "dissolved", community?.idHex ?? null],
    enabled: Boolean(community) && active,
    staleTime: 30_000,
    // A dissolution is a rare, terminal event; once stored it's cached forever
    // (the network branch below short-circuits). A slow, foreground-only poll
    // is plenty to notice it.
    refetchInterval: active ? 5 * 60_000 : false,
    refetchIntervalInBackground: false,
    queryFn: async ({ signal }) => {
      const group = dissolvedGroupKey(community!.id);
      // A dissolution tombstone is terminal and immutable — if we've already
      // stored one, we're done without touching the network.
      const cached = await queryByStreams([group.pk]);
      if (cached.some((o) => isDissolvedOpened(o, community!.owner))) return true;

      const results = await Promise.all(
        community!.relays.map((url) =>
          nostr
            .relay(url)
            .query([{ kinds: [KIND_WRAP], authors: [group.pk], limit: 10 }], {
              signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
            })
            .catch(() => [] as NostrEvent[]),
        ),
      );
      const opened = openPlaneWraps(results.flat(), [group]);
      if (opened.length > 0) writeOpened(opened);
      return opened.some((o) => isDissolvedOpened(o, community!.owner));
    },
  });
}

// ── Publishing ───────────────────────────────────────────────────────────────

/** Sign (plaintext seal) + wrap + broadcast one edition to the community relays. */
export async function publishEdition2(
  nostr: ReturnType<typeof useNostr>["nostr"],
  community: CommunityV2,
  signer: StreamSigner,
  rumor: Rumor,
): Promise<void> {
  const control = currentControlGroup(community);
  const wrap = await sealEdition(rumor, control, signer);
  const results = await Promise.allSettled(
    community.relays.map((url) => nostr.relay(url).event(wrap, { signal: AbortSignal.timeout(8000) })),
  );
  if (!results.some((r) => r.status === "fulfilled")) {
    throw new Error("No relay accepted the change.");
  }
  // Write our own edition to the local opened-event store immediately: the
  // refetch after invalidation unions the store, so the publisher's fold picks
  // the change up even if no relay echoes the wrap back (or the persisted
  // `since` cursor would skip it). Without this, a promote can "succeed" with
  // no visible effect until a full resync.
  try {
    writeOpened([openWrap(wrap, control)]);
  } catch {
    // best-effort — the relay echo remains the fallback
  }
}

/**
 * The authority citation an actor attaches to an action (CORD-04 §5): the
 * exact Grant edition they act under, pinned by coordinate + version + hash.
 * Absent when the owner acts — supreme needs no citation.
 */
export function citationFor(
  community: CommunityV2,
  folded: FoldedControl | undefined,
  actorHex: string,
): AuthorityCitation | undefined {
  if (!folded || actorHex === community.owner) return undefined;
  const eid = grantLocator(community.id, hex32(actorHex));
  const head = folded.heads.get(bytesToHex(eid));
  if (!head) return undefined;
  return { entityId: eid, version: head.version, editionHash: head.hash };
}

/** Invalidate every read that folds from the control plane. */
export function invalidateControl2(queryClient: ReturnType<typeof useQueryClient>, idHex: string): void {
  queryClient.invalidateQueries({ queryKey: ["concord2", "control", idHex] });
}
