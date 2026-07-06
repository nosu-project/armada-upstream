import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { useDeferredFold } from "@/concord-v2/hooks/useDeferredFold2";
import {
  controlGroups,
  currentControlGroup,
  foldControlState,
  isDissolvedOpened,
  openControlEditions,
  sealEdition,
  type FoldedControl,
} from "@/concord-v2/lib/control";
import { channelsView } from "@/concord-v2/lib/community";
import { bytesToHex, dissolvedGroupKey, grantLocator, hex32, type GroupKey } from "@/concord-v2/lib/derive";
import type { AuthorityCitation } from "@/concord-v2/lib/edition";
import { KIND_WRAP } from "@/concord-v2/lib/kinds";
import { queryByStreams, readStreamCursor, updateStreamCursor, writeOpened, drainPendingWraps } from "@/concord-v2/lib/rumorStore";
import { openWrap, type OpenedEvent, type Rumor, type StreamSigner } from "@/concord-v2/lib/stream";
import type { ChannelV2, CommunityV2 } from "@/concord-v2/lib/types";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

/**
 * The persisted control-fold snapshot key for a community (see
 * {@link useDeferredFold}). Shared with the notification-subscription builder,
 * which reads the cached fold without mounting a per-community hook.
 */
export const controlFoldKey = (idHex: string) => `concord2-fold:${idHex}`;

/** The persisted per-community control-plane sync cursor scope. */
const controlCursorScope = (idHex: string) => `control:${idHex}`;

/** Merge two opened-event sets by rumor id (a partial round must not drop editions). */
function mergeOpened(a: OpenedEvent[], b: OpenedEvent[]): OpenedEvent[] {
  const byId = new Map<string, OpenedEvent>();
  for (const e of a) byId.set(e.rumorId, e);
  for (const e of b) byId.set(e.rumorId, e);
  return [...byId.values()];
}

/** The relay filter selecting a community's control plane across held epochs. */
function controlFilter(community: CommunityV2, limit = 500): NostrFilter {
  return { kinds: [KIND_WRAP], authors: controlGroups(community).map((g) => g.pk), limit };
}

/** Decrypt raw control wraps under the held control groups into opened editions. */
function openControlRaw(wraps: NostrEvent[], groups: GroupKey[]): OpenedEvent[] {
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
 * Fetch the community's Control Plane: the editions at the control stream
 * address(es), read local-first from the decrypted opened-event cache and
 * refreshed from the relays. Roster, metadata, channels, banlist, and registries
 * are all folds of this SAME set.
 *
 * Wraps are NEVER persisted: incoming kind-1059 control wraps are decrypted once
 * (into opened editions carrying their signed seal for compaction) and written
 * to the opened-event store, which this query reads back with a `#stream` filter
 * and no decrypt. A persisted `since` cursor means editions already seen are
 * never refetched.
 *
 * `active` gates the NETWORK fetch (and the poll), not the local read. The rail
 * renders one button per community and only needs the icon/name from the
 * persisted fold snapshot, so rail buttons pass `active = false`.
 */
export function useControlEvents2(community: CommunityV2 | undefined, active = true) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();

  const cidHex = community?.idHex ?? null;
  const epochSig = community?.heldRoots.map((r) => r.epoch.toString()).join(",") ?? "";
  const queryKey = ["concord2", "control", cidHex, epochSig] as const;

  // Seed from the opened-event cache regardless of `active` — a local read that
  // lets the fold (and thus the rail icon) paint from cache without any network.
  useEffect(() => {
    if (!community) return;
    let cancelled = false;
    void (async () => {
      if ((queryClient.getQueryData<OpenedEvent[]>(queryKey)?.length ?? 0) > 0) return;
      const cached = await queryByStreams(controlGroups(community).map((g) => g.pk));
      if (cancelled || cached.length === 0) return;
      queryClient.setQueryData<OpenedEvent[]>(queryKey, (old) => (old && old.length > 0 ? old : cached));
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cidHex, epochSig, queryClient]);

  // Live subscription (open community only): stream new editions as they land.
  // Each wrap is decrypted, written to the opened cache, and merged into the
  // same query the fold reads; the poll below is a gap-filler for dropped subs.
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
              const opened = openControlRaw([msg[2] as NostrEvent], groups);
              if (opened.length === 0) continue;
              writeOpened(opened);
              void updateStreamCursor(controlCursorScope(community.idHex), {
                newest: opened[0].createdAt,
              });
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
    refetchInterval: active ? 60_000 : false,
    queryFn: async ({ signal }) => {
      const groups = controlGroups(community!);
      const scope = controlCursorScope(community!.idHex);
      // Drain any wraps the native service parked (it can't decrypt) into the
      // opened-event cache first.
      const parked = await drainPendingWraps(groups.map((g) => g.pk));
      if (parked.length > 0) writeOpened(openControlRaw(parked, groups));
      // Only fetch editions newer than the newest we've already stored — seen
      // editions are never refetched.
      const cursor = await readStreamCursor(scope);
      const base = controlFilter(community!);
      const filter: NostrFilter = cursor?.newest ? { ...base, since: cursor.newest } : base;

      const results = await Promise.all(
        community!.relays.map((url) =>
          nostr
            .relay(url)
            .query([filter], { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) })
            .catch(() => [] as NostrEvent[]),
        ),
      );
      const fresh = openControlRaw(results.flat(), groups);
      if (fresh.length > 0) {
        writeOpened(fresh);
        await updateStreamCursor(scope, { newest: Math.max(...fresh.map((e) => e.createdAt)) });
      }
      // Union the stored set with what we already hold + this round's fresh
      // editions: an edition chain is append-only, a short read must never drop.
      const stored = await queryByStreams(groups.map((g) => g.pk));
      const prev = queryClient.getQueryData<OpenedEvent[]>(queryKey) ?? [];
      return mergeOpened(mergeOpened(prev, stored), fresh);
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
      const editions = openControlEditions(events);
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
      const opened = openControlRaw(results.flat(), [group]);
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
