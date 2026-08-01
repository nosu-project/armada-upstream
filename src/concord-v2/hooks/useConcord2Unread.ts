import { useCallback, useMemo } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useCommunityRumors } from "@/concord-v2/hooks/useCommunityRumors";
import { KIND_MESSAGE } from "@/concord-v2/lib/kinds";
import type { ChannelV2 } from "@/concord-v2/lib/types";
import { concord2ReadKey, useReadState } from "@/hooks/useReadState";
import type { GitTimelineActivity } from "@/lib/gitActivity";

/** Per-channel unread summary (mirrors NIP-29's `GroupUnread`). */
export interface Concord2Unread {
  /** Newest unread message's created_at, unix SECONDS. */
  latest: number;
  /** Any unread message p-tags the current user. */
  mention: boolean;
}

/**
 * Per-channel unread state for a Concord V2 community, derived PURELY from the
 * shared community rumor scan ({@link useCommunityRumors}) and the shared
 * read-state map ({@link useReadState}) — no store access of its own. A channel
 * is unread when its newest non-self kind-9 is newer than the last-read
 * timestamp at its `c2:<channelIdHex>` read key.
 *
 * Read state lives in the one shared map alongside NIP-29 channels and DMs, so
 * it persists locally and syncs across devices via the encrypted NIP-78
 * settings event. Because the derivation is pure (no IndexedDB), a `markRead`
 * recomputes every mounted instance (rail + page) instantly.
 *
 * Returns `byChannel[channelIdHex]` (present ⇒ unread), a `markRead(channel,
 * ts)` to advance a channel's read stamp, and a `getLastRead` accessor.
 */
export function useConcord2Unread(
  communityIdHex: string | undefined,
  channels: ChannelV2[],
  gitByChannel: ReadonlyMap<string, readonly GitTimelineActivity[]> = new Map(),
): {
  byChannel: Record<string, Concord2Unread>;
  markRead: (channelIdHex: string, timestamp: number) => void;
  getLastRead: (channelIdHex: string) => number;
} {
  const { user } = useCurrentUser();
  const pubkey = user?.pubkey;
  const {
    readState,
    getLastRead: sharedGetLastRead,
    markRead: sharedMarkRead,
  } = useReadState();

  const channelSig = channels.map((c) => c.idHex).join(",");
  const channelIds = useMemo(() => channels.map((c) => c.idHex), [channelSig]); // eslint-disable-line react-hooks/exhaustive-deps

  // The one shared community read (see useCommunityRumors).
  const { byChannel: rumorsByChannel } = useCommunityRumors(communityIdHex, channelIds);

  const byChannel = useMemo<Record<string, Concord2Unread>>(() => {
    const next: Record<string, Concord2Unread> = {};
    for (const [idHex, rumors] of rumorsByChannel) {
      const lastRead = readState[concord2ReadKey(idHex)] ?? 0;
      let latest = 0;
      let latestMention = 0;
      for (const r of rumors) {
        if (r.kind !== KIND_MESSAGE) continue;
        if (r.author === pubkey) continue; // never unread from self
        if (r.createdAt > latest) latest = r.createdAt;
        if (r.createdAt > latestMention && r.tags.some(([n, v]) => n === "p" && v === pubkey)) {
          latestMention = r.createdAt;
        }
      }
      for (const activity of gitByChannel.get(idHex) ?? []) {
        const author = activity.type === "ticket-opened"
          ? activity.ticket.author
          : activity.type === "comment"
            ? activity.comment.author
            : activity.type === "ci-run"
              ? activity.run.author
              : activity.status.author;
        if (author === pubkey) continue;
        if (activity.createdAt > latest) latest = activity.createdAt;
      }
      if (latest > lastRead) next[idHex] = { latest, mention: latestMention > lastRead };
    }
    return next;
  }, [rumorsByChannel, readState, pubkey, gitByChannel]);

  const markRead = useCallback(
    (channelIdHex: string, timestamp: number) => {
      if (timestamp <= 0) return;
      sharedMarkRead(concord2ReadKey(channelIdHex), timestamp);
    },
    [sharedMarkRead],
  );

  const getLastRead = useCallback(
    (channelIdHex: string) => sharedGetLastRead(concord2ReadKey(channelIdHex)),
    [sharedGetLastRead],
  );

  return useMemo(() => ({ byChannel, markRead, getLastRead }), [byChannel, markRead, getLastRead]);
}
