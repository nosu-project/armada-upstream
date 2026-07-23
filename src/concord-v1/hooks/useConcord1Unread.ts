import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { bytesToHex } from "@noble/hashes/utils.js";

import { channelEpochKeyPairs, channelZs } from "@/concord-v1/lib/concordNotifications";
import { openMemoizedBatch } from "@/concord-v1/lib/decodeCache";
import { KIND_COMMUNITY_MESSAGE } from "@/concord-v1/lib/kinds";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useEventStore } from "@/hooks/useEventStore";
import { concord1ReadKey, useReadState } from "@/hooks/useReadState";
import { useWireScopes } from "@/wire/useWireScopes";

import type { Community } from "@/concord-v1/lib/types";

/** Per-channel unread summary (mirrors V2's `Concord2Unread`). */
export interface Concord1Unread {
  /** Newest unread message's created_at, unix SECONDS. */
  latest: number;
  /** Any unread message p-tags the current user. */
  mention: boolean;
}

/** Newest sealed outers scanned across a community's channels. */
const SCAN_LIMIT = 300;
/** Cap on outers decrypted per channel per scan (decrypts are memoized). */
const DECRYPT_LIMIT = 30;

/**
 * Compute per-channel unread state for a Concord V1 community — purely from
 * the shared IndexedDB event store, which the wire keeps fed with every
 * channel's sealed kind-3300 outers (web subscriptions + the APK service's
 * store writes). V1 finally gets the same unread model as NIP-29 and V2.
 *
 * The sealed outer carries a real `created_at` and its `#z` pseudonym, so the
 * cheap pass (is there anything newer than last-read?) needs NO decryption.
 * Only outers newer than last-read are opened — via the channel hooks'
 * memoized decode cache, so a rescan never re-decrypts — to exclude
 * self-authored messages and detect `p`-tag mentions.
 *
 * Read state lives in the one shared read-state map ({@link useReadState}) at
 * `c1:<channelIdHex>` keys — the same map NIP-29 channels, DMs, and V2
 * channels use — so it persists locally and syncs across devices via the
 * encrypted NIP-78 settings event.
 *
 * Re-derived when the wire bus announces a `c1:` change to a watched channel,
 * with a light poll as a backstop.
 */
export function useConcord1Unread(community: Community | undefined): {
  byChannel: Record<string, Concord1Unread>;
  markRead: (channelIdHex: string, timestamp: number) => void;
  getLastRead: (channelIdHex: string) => number;
} {
  const { user } = useCurrentUser();
  const pubkey = user?.pubkey;
  const queryClient = useQueryClient();
  const eventStore = useEventStore();
  const {
    readState,
    getLastRead: sharedGetLastRead,
    markRead: sharedMarkRead,
  } = useReadState();

  const channels = useMemo(() => community?.channels ?? [], [community]);
  const channelIdsHex = useMemo(() => channels.map((c) => bytesToHex(c.id)), [channels]);
  const channelSig = channelIdsHex.join(",");

  // The last-read stamps for just these channels; the unread query re-derives
  // when any of them advances.
  const lastReadByChannel = useMemo<Record<string, number>>(() => {
    const next: Record<string, number> = {};
    for (const idHex of channelIdsHex) next[idHex] = readState[concord1ReadKey(idHex)] ?? 0;
    return next;
  }, [channelIdsHex, readState]);

  const { data: byChannel = {} } = useQuery<Record<string, Concord1Unread>>({
    queryKey: ["concord1-unread", pubkey, channelSig, lastReadByChannel],
    queryFn: async () => {
      const store = await eventStore;
      const next: Record<string, Concord1Unread> = {};

      await Promise.all(
        channels.map(async (channel) => {
          const idHex = bytesToHex(channel.id);
          const lastRead = lastReadByChannel[idHex] ?? 0;
          const zs = channelZs(channel);
          if (zs.length === 0) return;

          let outers;
          try {
            outers = await store.query([
              { kinds: [KIND_COMMUNITY_MESSAGE], "#z": zs, limit: SCAN_LIMIT },
            ]);
          } catch {
            return;
          }
          // Cheap pass first: outer timestamps are real seconds, so anything
          // at or before last-read is skipped without touching the crypto.
          const candidates = outers
            .filter((e) => e.created_at > lastRead)
            .sort((a, b) => b.created_at - a.created_at)
            .slice(0, DECRYPT_LIMIT);
          if (candidates.length === 0) return;

          const opened = await openMemoizedBatch(candidates, channel.id, channelEpochKeyPairs(channel));
          let latest = 0;
          let mention = false;
          for (const m of opened) {
            if (m.kind !== KIND_COMMUNITY_MESSAGE) continue; // edits/reactions don't badge
            if (m.author === pubkey) continue; // never unread from self
            if (m.createdAt <= lastRead) continue;
            if (m.createdAt > latest) latest = m.createdAt;
            if (!mention && m.tags.some(([n, v]) => n === "p" && v === pubkey)) mention = true;
          }
          if (latest > 0) next[idHex] = { latest, mention };
        }),
      );
      return next;
    },
    enabled: !!pubkey && channels.length > 0,
    // Backstop poll (local reads + memoized decrypts); the bus is the fast path.
    refetchInterval: 15_000,
    staleTime: 0,
  });

  // Re-scan the moment the wire ingests a sealed outer for a watched channel.
  useWireScopes((scopes) => {
    for (const idHex of channelIdsHex) {
      if (scopes.has(`c1:${idHex}`)) {
        void queryClient.invalidateQueries({ queryKey: ["concord1-unread", pubkey] });
        return;
      }
    }
  });

  const markRead = useCallback(
    (channelIdHex: string, timestamp: number) => {
      if (timestamp <= 0) return;
      sharedMarkRead(concord1ReadKey(channelIdHex), timestamp);
    },
    [sharedMarkRead],
  );

  const getLastRead = useCallback(
    (channelIdHex: string) => sharedGetLastRead(concord1ReadKey(channelIdHex)),
    [sharedGetLastRead],
  );

  return useMemo(() => ({ byChannel, markRead, getLastRead }), [byChannel, markRead, getLastRead]);
}
