import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useMutedPubkeys } from "@/hooks/useMuteList";
import { useCommunityRumors } from "@/concord/hooks/useCommunityRumors";
import { quarantinedIn } from "@/concord/lib/floodCluster";
import {
  quarantineMemoryRevision,
  recallQuarantined,
  rememberQuarantined,
  subscribeQuarantineMemory,
} from "@/concord/lib/quarantineMemory";
import { KIND_MESSAGE } from "@/concord/lib/kinds";
import type { Channel } from "@/concord/lib/types";
import { concordReadKey, useReadState } from "@/hooks/useReadState";
import type { GitTimelineActivity } from "@/lib/gitActivity";

/** Per-channel unread summary (mirrors NIP-29's `GroupUnread`). */
export interface ConcordUnread {
  /** Newest unread message's created_at, unix SECONDS. */
  latest: number;
  /** Any unread message p-tags the current user. */
  mention: boolean;
}

/**
 * Per-channel unread state for a Concord community, derived PURELY from the
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
export function useConcordUnread(
  communityIdHex: string | undefined,
  channels: Channel[],
  gitByChannel: ReadonlyMap<string, readonly GitTimelineActivity[]> = new Map(),
): {
  byChannel: Record<string, ConcordUnread>;
  markRead: (channelIdHex: string, timestamp: number) => void;
  getLastRead: (channelIdHex: string) => number;
} {
  const { user } = useCurrentUser();
  const pubkey = user?.pubkey;
  const { mutedPubkeys } = useMutedPubkeys();
  const {
    readState,
    getLastRead: sharedGetLastRead,
    markRead: sharedMarkRead,
  } = useReadState();

  const channelSig = channels.map((c) => c.idHex).join(",");
  const channelIds = useMemo(() => channels.map((c) => c.idHex), [channelSig]); // eslint-disable-line react-hooks/exhaustive-deps

  // The one shared community read (see useCommunityRumors).
  const { byChannel: rumorsByChannel } = useCommunityRumors(communityIdHex, channelIds);

  // Re-derive when the persisted quarantine warms or grows: after a refresh
  // the live rules may see too little of the flood to re-fold it, and the
  // memory is what keeps its badges from coming back (see quarantineMemory.ts).
  const memoryRev = useSyncExternalStore(subscribeQuarantineMemory, quarantineMemoryRevision);

  // Remember what the badge path detected, so a refresh cannot resurrect it.
  // Merge-only, so a shallow batch here can never un-remember what the
  // timeline's better-informed fold stored.
  useEffect(() => {
    if (!communityIdHex) return;
    for (const [idHex, rumors] of rumorsByChannel) {
      const quarantined = quarantinedIn(rumors, pubkey);
      if (quarantined.size === 0) continue;
      const entries: Array<[string, number]> = [];
      for (const r of rumors) if (quarantined.has(r.rumorId)) entries.push([r.rumorId, r.ms]);
      if (entries.length > 0) void rememberQuarantined(communityIdHex, idHex, entries);
    }
  }, [communityIdHex, rumorsByChannel, pubkey]);

  const byChannel = useMemo<Record<string, ConcordUnread>>(() => {
    void memoryRev;
    const next: Record<string, ConcordUnread> = {};
    for (const [idHex, rumors] of rumorsByChannel) {
      const lastRead = readState[concordReadKey(idHex)] ?? 0;
      // A visual flood renders as ONE collapsed row, so counting its members
      // here would badge a channel — and on a big enough wave, every channel in
      // the community — for something the reader will see as a single line they
      // did not ask for. The fold is the render-layer answer to a flood; a
      // badge that still fires is the same interruption by another route.
      // Memoized on the batch's identity, so a readState recompute of this
      // memo (every markRead, every mounted instance) never re-runs the fold.
      const quarantined = quarantinedIn(rumors, pubkey);
      const remembered = communityIdHex ? recallQuarantined(communityIdHex, idHex) : undefined;
      let latest = 0;
      let latestMention = 0;
      for (const r of rumors) {
        if (r.kind !== KIND_MESSAGE) continue;
        if (r.author === pubkey) continue; // never unread from self
        // ...nor from someone muted: the timeline won't render their message,
        // so a badge counting it would be one the channel can never clear.
        if (mutedPubkeys.has(r.author)) continue;
        if (quarantined.has(r.rumorId)) continue;
        if (remembered?.has(r.rumorId)) continue;
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
        if (author === pubkey || mutedPubkeys.has(author)) continue;
        if (activity.createdAt > latest) latest = activity.createdAt;
      }
      if (latest > lastRead) next[idHex] = { latest, mention: latestMention > lastRead };
    }
    return next;
  }, [rumorsByChannel, readState, pubkey, gitByChannel, mutedPubkeys, communityIdHex, memoryRev]);

  const markRead = useCallback(
    (channelIdHex: string, timestamp: number) => {
      if (timestamp <= 0) return;
      sharedMarkRead(concordReadKey(channelIdHex), timestamp);
    },
    [sharedMarkRead],
  );

  const getLastRead = useCallback(
    (channelIdHex: string) => sharedGetLastRead(concordReadKey(channelIdHex)),
    [sharedGetLastRead],
  );

  return useMemo(() => ({ byChannel, markRead, getLastRead }), [byChannel, markRead, getLastRead]);
}
