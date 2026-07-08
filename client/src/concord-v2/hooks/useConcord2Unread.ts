import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { openChatBatch, type OpenedChat } from "@/concord-v2/lib/chat";
import {
  ackPendingWraps,
  peekPendingWraps,
  queryChannelRumors,
  writeRumors,
} from "@/concord-v2/lib/rumorStore";
import { KIND_MESSAGE } from "@/concord-v2/lib/kinds";
import type { ChannelV2 } from "@/concord-v2/lib/types";
import {
  loadConcord2ReadState,
  markConcord2Read,
  type Concord2ReadMap,
} from "@/concord-v2/lib/readState2";

import type { NostrEvent } from "@nostrify/nostrify";

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
 * Decrypt any wraps the native service parked for these channels and write the
 * recovered rumors to the store, returning them grouped by channel so the
 * caller can fold them into its scan without racing the fire-and-forget store
 * write.
 *
 * The native service subscribes to EVERY channel's streams but can't decrypt
 * (no stream keys), so it parks raw wraps. Historically the only drains were
 * the channel timeline / control plane queryFns — i.e. a wrap for a channel
 * that was never OPENED sat as ciphertext forever, and a push-notified message
 * never lit the in-app badge. Draining here (the badge scan runs every 5s for
 * every community mounted on the rail) closes that gap. Peek+ack semantics:
 * only wraps that actually decoded are acknowledged; an aborted or key-less
 * decode leaves them parked (issue #19).
 */
async function drainParkedWraps(channels: ChannelV2[]): Promise<Map<string, OpenedChat[]>> {
  const openedByChannel = new Map<string, OpenedChat[]>();
  try {
    const byPk = new Map<string, ChannelV2>();
    for (const c of channels) for (const s of c.streams) byPk.set(s.group.pk, c);
    if (byPk.size === 0) return openedByChannel;

    const parked = await peekPendingWraps([...byPk.keys()]);
    if (parked.length === 0) return openedByChannel;

    const wrapsByChannel = new Map<ChannelV2, NostrEvent[]>();
    for (const wrap of parked) {
      const channel = byPk.get(wrap.pubkey);
      if (!channel) continue;
      const list = wrapsByChannel.get(channel);
      if (list) list.push(wrap);
      else wrapsByChannel.set(channel, [wrap]);
    }

    const acked: string[] = [];
    for (const [channel, wraps] of wrapsByChannel) {
      const opened = await openChatBatch(wraps, channel);
      if (opened.length === 0) continue;
      writeRumors(opened);
      openedByChannel.set(channel.idHex, opened);
      const openedWrapIds = new Set(opened.map((o) => o.wrapId));
      acked.push(...wraps.filter((w) => openedWrapIds.has(w.id)).map((w) => w.id));
    }
    ackPendingWraps(acked);
  } catch {
    // Best-effort — the wraps stay parked for the next scan or channel open.
  }
  return openedByChannel;
}

/**
 * The TanStack Query key for a user's persisted V2 read-state map. Shared
 * across every `useConcord2Unread` call site (the rail icon AND the open
 * community page) so a `markRead` in one instantly updates the other — see
 * the "byChannel" query below, which is keyed off this same map.
 */
const readMapKey = (pubkey: string | undefined) => ["concord2-read-map", pubkey] as const;

/**
 * Compute per-channel unread state for a Concord V2 community — purely from the
 * local decrypted rumor cache (IndexedDB). No relay query is made: a channel
 * reads as unread when the newest cached message (kind-9, not authored by the
 * current user) is newer than the persisted last-read timestamp for that
 * channel.
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

  // Rescan the local cache for unread, comparing against `readMap`. Refetches
  // whenever the channel set or read map changes, and on a light interval so
  // badges pick up messages the active channel's live subscription (or the
  // background push ingest) has written to the cache without an explicit
  // event. Keyed off `readMap` itself (not just pubkey) so a `markRead` from
  // ANY mounted instance immediately invalidates this query for ALL of them.
  const { data: byChannel = {} } = useQuery<Record<string, Concord2Unread>>({
    queryKey: ["concord2-unread", pubkey, channelSig, readMap],
    queryFn: async () => {
      // Surface push-delivered messages first: decrypt whatever the native
      // service parked for these channels so they both light badges NOW and
      // are already in the store when their channel opens.
      const drained = await drainParkedWraps(channels);

      const next: Record<string, Concord2Unread> = {};
      await Promise.all(
        channelIds.map(async (idHex) => {
          const lastRead = readMap[idHex] ?? 0;
          let rumors: Array<Pick<OpenedChat, "kind" | "author" | "createdAt" | "tags">>;
          try {
            rumors = await queryChannelRumors(idHex, { limit: SCAN_LIMIT });
          } catch {
            rumors = [];
          }
          // Fold freshly-drained rumors in directly rather than racing the
          // fire-and-forget store write.
          const extra = drained.get(idHex);
          if (extra) rumors = [...rumors, ...extra];
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
    refetchInterval: 5000,
    staleTime: 0,
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
