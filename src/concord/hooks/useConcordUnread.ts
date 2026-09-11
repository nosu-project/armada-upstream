import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

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
import { KIND_DELETE, KIND_MESSAGE } from "@/concord/lib/kinds";
import { FUTURE_HOLD_MS } from "@/concord/lib/stream";
import type { Channel, Community } from "@/concord/lib/types";
import { useChatModeration } from "@/concord/hooks/useChannel";
import { concordReadKey, useReadState } from "@/hooks/useReadState";
import type { GitTimelineActivity } from "@/lib/gitActivity";
import { hasEveryoneMention } from "@/concord/lib/everyoneMention";

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
  community: Community | undefined,
  channels: Channel[],
  gitByChannel: ReadonlyMap<string, readonly GitTimelineActivity[]> = new Map(),
  active = false,
): {
  byChannel: Record<string, ConcordUnread>;
  markRead: (channelIdHex: string, timestamp: number) => void;
  getLastRead: (channelIdHex: string) => number;
} {
  const communityIdHex = community?.idHex;
  const { user } = useCurrentUser();
  const pubkey = user?.pubkey;
  const { mutedPubkeys } = useMutedPubkeys();
  // This scan reads the raw store, so the Banlist has to be applied here as
  // well as in the fold — otherwise a banned author keeps lighting channel
  // badges the timeline has nothing in it to clear (CORD-04 §4).
  //
  // Passive by DEFAULT, unlike the fold hooks below it. Every caller but the
  // open community's page is ambient — the rail's buttons, its folder mini
  // icons, its unread probes, the desktop badge counter — and each is mounted
  // once per joined community on every page of the app. Resolving moderation
  // actively there issues a control sweep per relay plus a 5-minute dissolved
  // probe for every community the reader has not opened, which is exactly the
  // fan-out the rail's own `useControlFold(community, false)` calls exist to
  // avoid. `banned` comes off the fold's persisted snapshot regardless, so the
  // Banlist drop is unaffected. The default is false so that a NEW ambient
  // caller cannot reintroduce the fan-out by forgetting to pass the flag; the
  // page opts in explicitly instead.
  const { banned, canMentionEveryone } = useChatModeration(community, active);
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
      if (entries.length > 0) rememberQuarantined(communityIdHex, idHex, entries);
    }
  }, [communityIdHex, rumorsByChannel, pubkey]);

  // Depend on this community's stamps only: `readState` is a new object on every
  // markRead anywhere, and the rail mounts one of these per community.
  const readStateRef = useRef(readState);
  readStateRef.current = readState;
  let readSig = "";
  for (const idHex of rumorsByChannel.keys()) readSig += `${readState[concordReadKey(idHex)] ?? 0},`;

  const byChannel = useMemo<Record<string, ConcordUnread>>(() => {
    void memoryRev;
    void readSig;
    const next: Record<string, ConcordUnread> = {};
    for (const [idHex, rumors] of rumorsByChannel) {
      const lastRead = readStateRef.current[concordReadKey(idHex)] ?? 0;
      // A visual flood renders as ONE collapsed row, so counting its members
      // here would badge a channel — and on a big enough wave, every channel in
      // the community — for something the reader will see as a single line they
      // did not ask for. The fold is the render-layer answer to a flood; a
      // badge that still fires is the same interruption by another route.
      //
      // A community PAUSE (CORD-04 §8) is deliberately NOT mirrored here, even
      // though it collapses rows the same way. Two reasons, and the second is
      // the deciding one. The population is negligible: the pause drops the
      // chat subscription outright, so the only messages that can reach this
      // scan at/after the pause are the ones already in flight when it landed.
      // And this path has no roster — it never resolves who is staff — so a
      // suppression here could not honor the staff exemption the fold applies,
      // and would silence exactly the moderator coordination a paused room
      // exists to make room for. Under-badging staff is worse than
      // over-badging a handful of stragglers.
      // Memoized on the batch's identity, so a readState recompute of this
      // memo (every markRead, every mounted instance) never re-runs the fold.
      const quarantined = quarantinedIn(rumors, pubkey);
      const remembered = communityIdHex ? recallQuarantined(communityIdHex, idHex) : undefined;
      // A kind-5 self-delete removes its target from the render (foldTimeline,
      // chat.ts) — but the store's NIP-09 pass only fires within one write
      // batch, so a delete a relay delivered in a LATER batch than its target
      // leaves that target physically in the store (chat.ts:302-308). This scan
      // reads the raw store, so a self-deleted NEWEST message would otherwise
      // pin `latest` above every rendered entry: a badge no open can clear,
      // because clear-on-open stamps the newest RENDERED (undeleted) row. Fold
      // deletes here so the count matches what the reader sees, exactly as the
      // muted-author skip below does. Self-deletes only (delete author ==
      // target author), which is all the store's own NIP-09 honors without a
      // roster and cannot be abused to suppress a stranger's still-shown message.
      const authorById = new Map<string, string>();
      for (const r of rumors) authorById.set(r.rumorId, r.author);
      const selfDeleted = new Set<string>();
      for (const r of rumors) {
        if (r.kind !== KIND_DELETE) continue;
        for (const [n, v] of r.tags) {
          if (n === "e" && v && authorById.get(v) === r.author) selfDeleted.add(v);
        }
      }
      let latest = 0;
      let latestMention = 0;
      // One clock for the whole scan, so a message crossing the hold boundary
      // mid-loop can't split it.
      const holdCeilingMs = Date.now() + FUTURE_HOLD_MS;
      for (const r of rumors) {
        if (r.kind !== KIND_MESSAGE) continue;
        if (r.author === pubkey) continue; // never unread from self
        // ...nor a message dated ahead of the local clock: the timeline HOLDS
        // it (foldTimeline / FUTURE_HOLD_MS) until its time comes, and a badge
        // counting it would mark the channel unread for a message the reader
        // can't yet see — cleared only once its timestamp catches up.
        if (r.ms > holdCeilingMs) continue;
        // ...nor from someone muted: the timeline won't render their message,
        // so a badge counting it would be one the channel can never clear.
        if (mutedPubkeys.has(r.author)) continue;
        // ...nor from a banned one: the fold drops their events entirely.
        if (banned.has(r.author)) continue;
        // ...nor a message its author has since deleted (same reasoning).
        if (selfDeleted.has(r.rumorId)) continue;
        if (quarantined.has(r.rumorId)) continue;
        if (remembered?.has(r.rumorId)) continue;
        if (r.createdAt > latest) latest = r.createdAt;
        const mentionsViewer = r.tags.some(([n, v]) => n === "p" && v === pubkey)
          || (hasEveryoneMention(r.content) && Boolean(canMentionEveryone?.(r.author, idHex)));
        if (r.createdAt > latestMention && mentionsViewer) {
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
  }, [rumorsByChannel, readSig, pubkey, gitByChannel, mutedPubkeys, banned, canMentionEveryone, communityIdHex, memoryRev]);

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
