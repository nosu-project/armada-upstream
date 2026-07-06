import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { useEventStore } from "@/hooks/useEventStore";
import { useDeferredFold } from "@/concord-v2/hooks/useDeferredFold2";
import {
  controlGroups,
  currentControlGroup,
  foldControlState,
  isDissolved,
  openControlWraps,
  sealEdition,
  type FoldedControl,
} from "@/concord-v2/lib/control";
import { channelsView } from "@/concord-v2/lib/community";
import { bytesToHex, dissolvedGroupKey, grantLocator, hex32 } from "@/concord-v2/lib/derive";
import type { AuthorityCitation } from "@/concord-v2/lib/edition";
import { KIND_WRAP } from "@/concord-v2/lib/kinds";
import type { Rumor, StreamSigner } from "@/concord-v2/lib/stream";
import type { ChannelV2, CommunityV2 } from "@/concord-v2/lib/types";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

/**
 * The persisted control-fold snapshot key for a community (see
 * {@link useDeferredFold}). Shared with the notification-subscription builder,
 * which reads the cached fold without mounting a per-community hook.
 */
export const controlFoldKey = (idHex: string) => `concord2-fold:${idHex}`;

/** Merge two wrap sets by id (a partial network round must not drop editions). */
function mergeById(a: NostrEvent[], b: NostrEvent[]): NostrEvent[] {
  const byId = new Map<string, NostrEvent>();
  for (const e of a) byId.set(e.id, e);
  for (const e of b) byId.set(e.id, e);
  return [...byId.values()];
}

/** The relay filter selecting a community's control plane across held epochs. */
function controlFilter(community: CommunityV2, limit = 500): NostrFilter {
  return { kinds: [KIND_WRAP], authors: controlGroups(community).map((g) => g.pk), limit };
}

/**
 * Fetch the community's Control Plane ONCE: the kind-1059 wraps at the control
 * stream address(es). Roster, metadata, channels, banlist, and registries are
 * all folds of this SAME event set. Cache-first: wraps mirrored into IndexedDB
 * by the batcher seed the query before the network resolves.
 *
 * `active` gates the NETWORK fetch (and the 30s poll), not the IndexedDB seed or
 * the persisted fold snapshot. The server rail renders one button per community
 * on every page and only needs the community's icon/name — which it reads from
 * the persisted `concord2-fold:` snapshot without any network. So rail buttons
 * pass `active = false`: no per-relay control-plane fan-out on pageload for the
 * N communities you AREN'T looking at. The open community's page passes
 * `active = true`, so navigating INTO a community is what syncs its control
 * plane. All consumers share one query key, so the rail button for the open
 * community reuses the page's live query.
 */
export function useControlEvents2(community: CommunityV2 | undefined, active = true) {
  const { nostr } = useNostr();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();

  const cidHex = community?.idHex ?? null;
  const epochSig = community?.heldRoots.map((r) => r.epoch.toString()).join(",") ?? "";
  const queryKey = ["concord2", "control", cidHex, epochSig] as const;

  // Seed from IndexedDB regardless of `active` — it's a local read that lets the
  // fold (and thus the rail icon) paint from cache without hitting the network.
  useEffect(() => {
    if (!community) return;
    let cancelled = false;
    void (async () => {
      if ((queryClient.getQueryData<NostrEvent[]>(queryKey)?.length ?? 0) > 0) return;
      const store = await eventStore;
      const cached = await store.query([controlFilter(community)]);
      if (cancelled || cached.length === 0) return;
      queryClient.setQueryData<NostrEvent[]>(queryKey, (old) => (old && old.length > 0 ? old : cached));
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cidHex, epochSig, eventStore, queryClient]);

  // Live subscription (open community only): stream new control editions as they
  // land instead of waiting up to a poll interval, so a new role/metadata edit/
  // ban/channel shows within seconds. Each EVENT is merged into the same query
  // cache the fold reads; the poll below stays as a gap-filler for dropped subs.
  useEffect(() => {
    if (!community || !active) return;
    const controller = new AbortController();
    const since = Math.floor(Date.now() / 1000);
    const { limit: _limit, ...base } = controlFilter(community);
    const filter = { ...base, since };
    for (const url of community.relays) {
      void (async () => {
        try {
          for await (const msg of nostr.relay(url).req([filter], { signal: controller.signal })) {
            if (msg[0] === "EVENT") {
              const event = msg[2] as NostrEvent;
              queryClient.setQueryData<NostrEvent[]>(queryKey, (old) =>
                old?.some((e) => e.id === event.id) ? old : mergeById(old ?? [], [event]),
              );
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

  return useQuery<NostrEvent[]>({
    queryKey,
    enabled: Boolean(community) && active,
    staleTime: 15_000,
    // The live subscription above provides real-time freshness; the poll is a
    // longer-interval safety net for a dropped/expired subscription.
    refetchInterval: active ? 60_000 : false,
    queryFn: async ({ signal }) => {
      const results = await Promise.all(
        community!.relays.map((url) =>
          nostr
            .relay(url)
            .query([controlFilter(community!)], { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) })
            .catch(() => [] as NostrEvent[]),
        ),
      );
      // Union with what we already hold: editions are append-only chains, a
      // relay returning a partial page must never drop held editions.
      const prev = queryClient.getQueryData<NostrEvent[]>(queryKey) ?? [];
      return mergeById(prev, results.flat());
    },
  });
}

/**
 * The Control Plane replayed into current state (roster, metadata, channels,
 * banlist, registries). Folded OFF the render path with a persisted snapshot,
 * so a large control plane never gates the first paint.
 *
 * `active` is forwarded to the network fetch (see {@link useControlEvents2});
 * when false the fold still resolves from the persisted snapshot, so the rail
 * icon/name paints without any control-plane REQ.
 */
export function useControlFold2(community: CommunityV2 | undefined, active = true) {
  const control = useControlEvents2(community, active);
  const events = control.data;

  const data = useDeferredFold<FoldedControl>(
    community ? controlFoldKey(community.idHex) : null,
    () => {
      if (!community || !events) return undefined;
      const editions = openControlWraps(events, controlGroups(community));
      return foldControlState(editions, community.id, community.owner);
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
    refetchInterval: active ? 60_000 : false,
    queryFn: async ({ signal }) => {
      const address = dissolvedGroupKey(community!.id).pk;
      const results = await Promise.all(
        community!.relays.map((url) =>
          nostr
            .relay(url)
            .query([{ kinds: [KIND_WRAP], authors: [address], limit: 10 }], {
              signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
            })
            .catch(() => [] as NostrEvent[]),
        ),
      );
      return isDissolved(results.flat(), community!.id, community!.owner);
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
