import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { queryChannelRumors } from "@/concord-v2/lib/rumorStore";
import { KIND_MESSAGE } from "@/concord-v2/lib/kinds";
import type { ChannelV2 } from "@/concord-v2/lib/types";
import {
  loadConcord2ReadState,
  markConcord2Read,
  type Concord2ReadMap,
} from "@/concord-v2/lib/readState2";

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
 * Compute per-channel unread state for a Concord V2 community — purely from the
 * local decrypted rumor cache (IndexedDB). No relay query is made: a channel
 * reads as unread when the newest cached message (kind-9, not authored by the
 * current user) is newer than the persisted last-read timestamp for that
 * channel.
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

  const [readMap, setReadMap] = useState<Concord2ReadMap>({});
  const [byChannel, setByChannel] = useState<Record<string, Concord2Unread>>({});

  // A stable list of channel ids (recomputed only when the set changes), so the
  // scan callback and its interval don't churn on every parent re-render.
  const channelSig = channels.map((c) => c.idHex).join(",");
  const channelIds = useMemo(() => channels.map((c) => c.idHex), [channelSig]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load the persisted read map when the user changes.
  useEffect(() => {
    if (!pubkey) {
      setReadMap({});
      return;
    }
    let alive = true;
    void loadConcord2ReadState(pubkey).then((map) => {
      if (alive) setReadMap(map);
    });
    return () => {
      alive = false;
    };
  }, [pubkey]);

  // Rescan the local cache for unread, comparing against `readMap`. Runs on
  // channel-set / read-map change and on a light interval so badges pick up
  // messages the active channel's live subscription (or the background push
  // ingest) has written to the cache without an explicit event.
  const readMapRef = useRef(readMap);
  readMapRef.current = readMap;

  const scan = useCallback(async () => {
    if (!pubkey || channelIds.length === 0) {
      setByChannel({});
      return;
    }
    const map = readMapRef.current;
    const next: Record<string, Concord2Unread> = {};
    await Promise.all(
      channelIds.map(async (idHex) => {
        const lastRead = map[idHex] ?? 0;
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
    setByChannel(next);
  }, [pubkey, channelIds]);

  // Rescan on channel-set change (via `scan`) or when the read map advances, and
  // on a light interval so badges pick up messages the active channel's live
  // subscription (or the background push ingest) writes to the cache.
  useEffect(() => {
    void scan();
    const id = setInterval(() => void scan(), 5000);
    return () => clearInterval(id);
  }, [scan, readMap]);

  const markRead = useCallback(
    (channelIdHex: string, timestamp: number) => {
      if (!pubkey || timestamp <= 0) return;
      // Optimistically clear the badge and advance the in-memory map so the
      // rescan doesn't re-light it, then persist.
      setReadMap((prev) => ((prev[channelIdHex] ?? 0) >= timestamp ? prev : { ...prev, [channelIdHex]: timestamp }));
      setByChannel((prev) => {
        if (!prev[channelIdHex]) return prev;
        const { [channelIdHex]: _drop, ...rest } = prev;
        return rest;
      });
      void markConcord2Read(pubkey, channelIdHex, timestamp).then(setReadMap);
    },
    [pubkey],
  );

  const getLastRead = useCallback((channelIdHex: string) => readMap[channelIdHex] ?? 0, [readMap]);

  return useMemo(() => ({ byChannel, markRead, getLastRead }), [byChannel, markRead, getLastRead]);
}
