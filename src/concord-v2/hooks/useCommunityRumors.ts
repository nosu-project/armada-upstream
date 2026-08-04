import { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { queryRumorsByChannel } from "@/concord-v2/lib/rumorStore";
import { STORE_READ } from "@/lib/storeQuery";
import { useWireScopes } from "@/wire/useWireScopes";

import type { OpenedChat } from "@/concord-v2/lib/chat";

/**
 * How many newest rumors to read per channel for the community-wide derived
 * views (unread badges, threads). Sized for thread reconstruction (the most
 * demanding consumer); unread only needs the newest.
 */
const PER_CHANNEL = 200;

/**
 * The single shared read of a Concord V2 community's cached rumors, grouped by
 * channel. The community-wide derived views that only need each channel's
 * newest window — unread badges and the Threads tab — read from THIS one query
 * rather than each scanning the store independently. (Mentions deliberately do
 * NOT: a mention older than a busy channel's window must still surface, so
 * they keep their own index-backed `#p` filter — see `useConcord2Mentions`.)
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
    () => ["concord2-community-rumors", communityIdHex ?? null, channelSig] as const,
    [communityIdHex, channelSig],
  );

  const { data, isLoading } = useQuery<Map<string, OpenedChat[]>>({
    ...STORE_READ,
    queryKey,
    queryFn: ({ signal }) =>
      queryRumorsByChannel(communityIdHex!, channelIds, { perChannel: PER_CHANNEL, signal }),
    enabled: !!communityIdHex && channelIds.length > 0,
    // The wire bus below is the live path (per-channel delta reads); this
    // interval is only a backstop for an announcement this tab never heard
    // (e.g. a write from another tab). It re-runs the FULL N-channel scan,
    // which contends with the active channel's own reads on the shared store
    // connection — keep it slow.
    refetchInterval: 2 * 60_000,
    // The wire bus below is the live path and the interval the backstop; a
    // finite staleTime only added focus/remount re-runs of the full scan.
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
    void queryRumorsByChannel(communityIdHex, changed, { perChannel: PER_CHANNEL })
      .then((delta) => {
        queryClient.setQueryData<Map<string, OpenedChat[]>>(queryKey, (old) => {
          // Until the initial full scan lands there is nothing to patch — and
          // that scan will include this delta's rows anyway.
          if (!old) return undefined;
          const next = new Map(old);
          for (const id of changed) {
            const rows = delta.get(id);
            if (rows) next.set(id, rows);
            else next.delete(id);
          }
          return next;
        });
      })
      .catch(() => undefined);
  });

  return { byChannel: data ?? EMPTY, isLoading };
}

const EMPTY: Map<string, OpenedChat[]> = new Map();
