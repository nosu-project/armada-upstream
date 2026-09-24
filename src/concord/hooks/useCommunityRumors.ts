import { useMemo } from "react";
import { hashKey, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { queryRumorsByChannel } from "@/concord/lib/rumorStore";
import { STORE_READ } from "@/lib/storeQuery";
import { useWireScopes } from "@/wire/useWireScopes";

import type { OpenedChat } from "@/concord/lib/chat";

/**
 * How many newest rumors to read per channel for the community-wide derived
 * views (unread badges, threads). Sized for thread reconstruction (the most
 * demanding consumer); unread only needs the newest.
 */
const PER_CHANNEL = 200;

/**
 * The single shared read of a Concord community's cached rumors, grouped by
 * channel. The community-wide derived views that only need each channel's
 * newest window — unread badges and the Threads tab — read from THIS one query
 * rather than each scanning the store independently. (Mentions deliberately do
 * NOT: a mention older than a busy channel's window must still surface, so
 * they keep their own index-backed `#p` filter — see `useConcordMentions`.)
 *
 * Why this exists: those views used to each loop every channel with its own
 * `queryChannelRumors`, so a community with N channels issued a transaction
 * per channel per view, all contending on the single connection with the
 * active channel's own timeline read — the channel-switch stall. Here it is
 * one `query()` (one transaction, one filter per channel) shared across
 * consumers, re-run only when the wire actually ingests a rumor for a watched
 * channel.
 *
 * The result is keyed by the channel SET (not any read-state), so opening a
 * channel — which advances read state but changes no rumors — never re-reads
 * the store; the read-dependent bits (is-unread, has-new) are derived downstream
 * as pure computation.
 */
export function useCommunityRumors(
  communityIdHex: string | undefined,
  channelIds: string[],
): {
  byChannel: Map<string, OpenedChat[]>;
  isLoading: boolean;
} {
  const queryClient = useQueryClient();

  // Stable key + membership set (recomputed only when the set changes).
  const channelSig = channelIds.join(",");
  const idSet = useMemo(() => new Set(channelIds), [channelSig]); // eslint-disable-line react-hooks/exhaustive-deps

  const queryKey = useMemo(
    () => ["concord-community-rumors", communityIdHex ?? null, channelSig] as const,
    [communityIdHex, channelSig],
  );

  const { data, isLoading } = useQuery<Map<string, OpenedChat[]>>({
    ...STORE_READ,
    queryKey,
    queryFn: ({ signal }) =>
      queryRumorsByChannel(communityIdHex!, channelIds, { perChannel: PER_CHANNEL, signal }),
    enabled: !!communityIdHex && channelIds.length > 0,
    // NO refetch interval: the wire bus below is the COMPLETE in-process live
    // path. Every write of a community rumor rings `c2:<channel>` once it
    // commits — `writeRumors` and `sweepExpiredCommunityRumors`, pinned in
    // rumorStore.test.ts as a superset ring (over-rings, never under-rings) —
    // and the delta handler below re-reads only the channels that changed.
    //
    // The old backstop re-ran the FULL N-channel scan for its community on a
    // 2-minute clock, and the always-mounted rail mounts one of these PER
    // joined community regardless of screen. So a power user paid N independent
    // periodic full scans on unaligned phases, smearing across the window and
    // contending on the one store connection — the recurring O(N) foreground
    // load behind the "fine for new users, bad for power users" hitches. Its
    // stated reason ("a write from another tab") is covered by the bus itself:
    // each flushed batch is mirrored across same-origin contexts over a
    // BroadcastChannel (bus.ts), so another tab's committed write rings this
    // one's delta handler too — the single shared doorbell that cross-context
    // gap wanted, not N forever-polls. On the single-context platforms
    // (Android/iOS/desktop) — the ones with the lag — the mirror simply has no
    // other subscriber, and the service-written rows ring through the drain's
    // pass over wire ingest.
    staleTime: Infinity,
  });

  // Delta-read when the wire ingests a rumor for a watched channel: re-scan
  // ONLY the channels that changed and patch them into the cached map. The
  // previous full invalidation re-ran the N×PER_CHANNEL scan on every ingest
  // burst, serializing against the active channel's timeline read — a real
  // channel-switch tax on busy communities. The bus already coalesces a burst
  // of writes into one flush, so this fires at most once per burst.
  useWireScopes((scopes) => {
    const changed: string[] = [];
    for (const s of scopes) {
      if (s.startsWith("c2:") && idSet.has(s.slice(3))) changed.push(s.slice(3));
    }
    if (changed.length === 0 || !communityIdHex) return;
    scheduleDelta(queryClient, queryKey, communityIdHex, changed);
  });

  return { byChannel: data ?? EMPTY, isLoading };
}

const EMPTY: Map<string, OpenedChat[]> = new Map();

/**
 * Delta reads waiting for this microtask, per query key. Every consumer of a
 * community's rumors (unread badges, threads, the members view, time
 * travelers) mounts its own copy of this hook, and the bus rings them all in
 * one flush — so without coalescing, ONE ring ran one store read and one cache
 * replacement PER CONSUMER, each replacement a render of everything reading
 * the key. Collected here, they run once.
 */
const pendingDeltas = new Map<string, Set<string>>();

function scheduleDelta(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  communityIdHex: string,
  changed: string[],
): void {
  const key = hashKey(queryKey);
  const pending = pendingDeltas.get(key);
  if (pending) {
    for (const id of changed) pending.add(id);
    return;
  }
  const channels = new Set(changed);
  pendingDeltas.set(key, channels);
  queueMicrotask(() => {
    pendingDeltas.delete(key);
    const ids = [...channels];
    void queryRumorsByChannel(communityIdHex, ids, { perChannel: PER_CHANNEL })
      .then((delta) => {
        queryClient.setQueryData<Map<string, OpenedChat[]>>(queryKey, (old) => {
          // Until the initial full scan lands there is nothing to patch — and
          // that scan will include this delta's rows anyway.
          if (!old) return undefined;
          let next: Map<string, OpenedChat[]> | undefined;
          for (const id of ids) {
            const rows = delta.get(id);
            const prev = old.get(id);
            // A ring that changed nothing this channel shows (a sync round
            // that found no news rings anyway) keeps the old arrays — and,
            // when no channel changed, the old Map, so nothing re-renders.
            if (rows ? prev !== undefined && sameRows(prev, rows) : prev === undefined) continue;
            next ??= new Map(old);
            if (rows) next.set(id, rows);
            else next.delete(id);
          }
          return next ?? old;
        });
      })
      .catch(() => undefined);
  });
}

/** Same rumors, same order — rumors are immutable, so the id says it all. */
function sameRows(a: OpenedChat[], b: OpenedChat[]): boolean {
  return a.length === b.length && a.every((row, i) => row.rumorId === b[i].rumorId);
}
