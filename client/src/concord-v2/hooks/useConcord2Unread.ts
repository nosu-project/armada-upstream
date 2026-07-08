import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { queryChannelRumors } from "@/concord-v2/lib/rumorStore";
import { KIND_MESSAGE } from "@/concord-v2/lib/kinds";
import type { ChannelV2 } from "@/concord-v2/lib/types";
import {
  loadConcord2ReadState,
  markConcord2Read,
  type Concord2ReadMap,
} from "@/concord-v2/lib/readState2";
import { useWireScopes } from "@/wire/useWireScopes";

/** Per-channel unread summary (mirrors NIP-29's `GroupUnread`). */
export interface Concord2Unread {
  /** Newest unread message's created_at, unix SECONDS. */
  latest: number;
  /** Any unread message p-tags the current user. */
  mention: boolean;
}

/** How many newest cached rumors to inspect per channel when scanning. */
const SCAN_LIMIT = 60;

/**
 * The TanStack Query key for a user's persisted V2 read-state map. Shared
 * across every `useConcord2Unread` call site (the rail icon AND the open
 * community page) so a `markRead` in one instantly updates the other — see
 * the "byChannel" query below, which is keyed off this same map.
 */
const readMapKey = (pubkey: string | undefined) => ["concord2-read-map", pubkey] as const;

/**
 * Compute per-channel unread state for a Concord V2 community — purely from the
 * local decrypted rumor cache (IndexedDB), which the wire keeps fed for EVERY
 * channel (live web subscriptions + the native service's parked wraps, both
 * decrypted at ingest). No relay query is made: a channel reads as unread when
 * the newest cached message (kind-9, not authored by the current user) is
 * newer than the persisted last-read timestamp for that channel.
 *
 * Re-derived the moment the wire bus announces a `c2:` change to a watched
 * channel, with a light poll as a backstop.
 *
 * The read-state map and the derived per-channel unread scan both live in the
 * shared TanStack Query cache (keyed by pubkey, resp. pubkey+channel-set+map)
 * rather than per-hook-instance React state. This hook is mounted separately
 * by the rail icon (`Concord2Button`, persistent) and by the open community
 * page (`ConcordV2Page`) — without a shared cache, marking a channel read on
 * the page would never clear the rail's badge until a full reload re-mounted
 * it and re-read the map from IndexedDB.
 *
 * Returns `byChannel[channelIdHex]` (present ⇒ unread), a `markRead(channel,
 * ts)` to advance a channel's read stamp, and the raw read map (seconds).
 */
export function useConcord2Unread(channels: ChannelV2[]): {
  byChannel: Record<string, Concord2Unread>;
  markRead: (channelIdHex: string, timestamp: number) => void;
  getLastRead: (channelIdHex: string) => number;
} {
  const { user } = useCurrentUser();
  const pubkey = user?.pubkey;
  const queryClient = useQueryClient();

  // A stable list of channel ids (recomputed only when the set changes), so
  // the byChannel query key doesn't churn on every parent re-render.
  const channelSig = channels.map((c) => c.idHex).join(",");
  const channelIds = useMemo(() => channels.map((c) => c.idHex), [channelSig]); // eslint-disable-line react-hooks/exhaustive-deps

  // The persisted read map, shared across every mounted instance of this hook
  // via the query cache — `markRead` below updates it with `setQueryData`,
  // which notifies all subscribers (rail + page) synchronously.
  const { data: readMap = {} } = useQuery<Concord2ReadMap>({
    queryKey: readMapKey(pubkey),
    queryFn: () => loadConcord2ReadState(pubkey!),
    enabled: !!pubkey,
    staleTime: Infinity,
  });

  // Rescan the local cache for unread, comparing against `readMap`. Keyed off
  // `readMap` itself (not just pubkey) so a `markRead` from ANY mounted
  // instance immediately invalidates this query for ALL of them.
  const { data: byChannel = {} } = useQuery<Record<string, Concord2Unread>>({
    queryKey: ["concord2-unread", pubkey, channelSig, readMap],
    queryFn: async () => {
      const next: Record<string, Concord2Unread> = {};
      await Promise.all(
        channelIds.map(async (idHex) => {
          const lastRead = readMap[idHex] ?? 0;
          let rumors;
          try {
            rumors = await queryChannelRumors(idHex, { limit: SCAN_LIMIT });
          } catch {
            return;
          }
          let latest = 0;
          let mention = false;
          for (const r of rumors) {
            if (r.kind !== KIND_MESSAGE) continue;
            if (r.author === pubkey) continue; // never unread from self
            if (r.createdAt <= lastRead) continue;
            if (r.createdAt > latest) latest = r.createdAt;
            if (!mention && r.tags.some(([n, v]) => n === "p" && v === pubkey)) mention = true;
          }
          if (latest > 0) next[idHex] = { latest, mention };
        }),
      );
      return next;
    },
    enabled: !!pubkey && channelIds.length > 0,
    // Backstop poll (cheap local reads); the wire bus below is the fast path.
    refetchInterval: 15_000,
    staleTime: 0,
  });

  // Re-scan the moment the wire ingests a rumor for any watched channel.
  useWireScopes((scopes) => {
    for (const idHex of channelIds) {
      if (scopes.has(`c2:${idHex}`)) {
        void queryClient.invalidateQueries({ queryKey: ["concord2-unread", pubkey] });
        return;
      }
    }
  });

  const markRead = useCallback(
    (channelIdHex: string, timestamp: number) => {
      if (!pubkey || timestamp <= 0) return;
      // Optimistically advance the shared read map so every mounted instance
      // (rail + page) re-derives its unread state immediately, then persist.
      queryClient.setQueryData<Concord2ReadMap>(readMapKey(pubkey), (prev = {}) =>
        (prev[channelIdHex] ?? 0) >= timestamp ? prev : { ...prev, [channelIdHex]: timestamp },
      );
      void markConcord2Read(pubkey, channelIdHex, timestamp).then((map) => {
        queryClient.setQueryData(readMapKey(pubkey), map);
      });
    },
    [pubkey, queryClient],
  );

  const getLastRead = useCallback((channelIdHex: string) => readMap[channelIdHex] ?? 0, [readMap]);

  return useMemo(() => ({ byChannel, markRead, getLastRead }), [byChannel, markRead, getLastRead]);
}
