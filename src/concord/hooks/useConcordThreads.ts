import { useCallback, useMemo } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useMutedPubkeys } from "@/hooks/useMuteList";
import { useChatModeration } from "@/concord/hooks/useChannel";
import { useCommunityRumors } from "@/concord/hooks/useCommunityRumors";
import { foldTimeline, replyTargetOf, type OpenedChat } from "@/concord/lib/chat";
import { openedToChatMsg } from "@/concord/hooks/useTransport";
import type { Channel, Community } from "@/concord/lib/types";
import type { ChatMsg } from "@/components/chat/transport";
import type { NostrEvent } from "@nostrify/nostrify";
import { concordThreadReadKey, useReadState } from "@/hooks/useReadState";

/**
 * Whether the thread root is a tombstone (a synthetic placeholder for a root
 * message that hasn't been decoded/loaded yet). Checked by the ThreadPanel so
 * it can render a "message not loaded" placeholder instead of the root's
 * content/avatar.
 */
export function isTombstoneRoot(root: ChatMsg): boolean {
  return root.pubkey === TOMBSTONE_PUBKEY;
}

/** Synthetic pubkey used to mark a tombstone root (never a real one). */
const TOMBSTONE_PUBKEY = "\u0000tombstone";

/** A thread the current user has participated in, summarized for the tab. */
export interface ConcordThread {
  /** The thread root message, adapted for the shared chat components. */
  root: ChatMsg;
  /** The channel the thread lives in (for jumping / opening the panel). */
  channelIdHex: string;
  /** Number of replies (excluding the root). */
  replyCount: number;
  /** Newest reply's `created_at` (unix SECONDS) — the sort/recency key. */
  lastReplyAt: number;
  /** Distinct repliers, newest-first (for an avatar stack). */
  participants: string[];
  /** A reply newer than the user last saw this thread (never self-authored). */
  hasNew: boolean;
}

/**
 * Threads the current user has participated in across a Concord community —
 * every thread whose root or any reply they authored — summarized newest-reply
 * first, derived PURELY from the shared community rumor scan
 * ({@link useCommunityRumors}). No store access of its own.
 *
 * "New" is per-thread: a thread lights up when its newest reply is newer than
 * the last time the user saw it. Those stamps live in the shared read-state
 * map at `c2t:<rootRumorId>` — the same map channels and DMs use, so they
 * sync across devices via the encrypted NIP-78 settings event. The per-thread
 * comparison is pure computation layered over the shared scan, so `markRead`
 * recomputes instantly. Reading a channel that shows a thread's replies also
 * advances that thread's stamp (the open-channel effect in ConcordPage).
 */
export function useConcordThreads(community: Community | undefined, channels: Channel[]): {
  threads: ConcordThread[];
  isLoading: boolean;
  hasNew: boolean;
  markRead: (rootId: string, timestamp: number) => void;
  markAllRead: () => void;
} {
  const { user } = useCurrentUser();
  const pubkey = user?.pubkey;
  const { mutedPubkeys } = useMutedPubkeys();
  const { readState, markRead: sharedMarkRead } = useReadState();
  const communityIdHex = community?.idHex;
  // The same context the channel timeline folds under. Without it the fold
  // silently skips the Banlist drop and every moderator delete (both branches
  // short-circuit on `moderation &&`), so a banned author's replies kept
  // rendering here — and kept inflating reply counts, participant stacks and
  // the "new replies" dot — after they had vanished from the channel itself.
  // CORD-04 §4 admits no such exemption: every honest client drops EVERY event
  // from a banned npub.
  const moderation = useChatModeration(community);

  const channelSig = channels.map((c) => c.idHex).join(",");
  const channelIds = useMemo(() => channels.map((c) => c.idHex), [channelSig]); // eslint-disable-line react-hooks/exhaustive-deps

  const { byChannel: rumorsByChannel, isLoading } = useCommunityRumors(communityIdHex, channelIds);

  // Bucket each channel's folded rumors into the threads the user is in. Pure
  // computation over the shared scan — no store, no readMap dependency (that is
  // layered on below).
  const scanned = useMemo(() => {
    const out: Array<{
      root: ChatMsg;
      rootId: string;
      newestReplyAuthor: string;
      channelIdHex: string;
      replyCount: number;
      lastReplyAt: number;
      participants: string[];
    }> = [];

    for (const [idHex, rumors] of rumorsByChannel) {
      // Drop muted authors before folding, so a muted person contributes
      // neither a listed thread, a reply count, an avatar in the participant
      // stack, nor a "new replies" dot. A thread whose ROOT is muted vanishes
      // with it: `byId` no longer resolves the root, and it degrades to the
      // same tombstone an out-of-window root gets.
      const folded = foldTimeline(rumors, moderation);
      const messages = folded.messages.filter(
        (m) => !mutedPubkeys.has(m.author) && !folded.quarantined.has(m.rumorId),
      );
      const byId = new Map(messages.map((m) => [m.rumorId, m]));

      // Bucket thread replies by their root. A thread reply is a NIP-22
      // kind-1111 comment (uppercase `E` root); a kind-9 `q` is an inline reply
      // and never a thread (see `replyTargetOf`).
      const repliesByRoot = new Map<string, OpenedChat[]>();
      for (const m of messages) {
        const root = replyTargetOf(m);
        if (!root) continue;
        const list = repliesByRoot.get(root) ?? [];
        list.push(m);
        repliesByRoot.set(root, list);
      }

      for (const [rootId, replies] of repliesByRoot) {
        const rootMsg = byId.get(rootId);
        const authoredRoot = rootMsg?.author === pubkey;
        const authoredReply = replies.some((r) => r.author === pubkey);
        if (!authoredRoot && !authoredReply) continue;

        replies.sort((a, b) => a.ms - b.ms);
        const newest = replies[replies.length - 1];

        // Distinct repliers, newest-first (avatar stack).
        const participants: string[] = [];
        const seen = new Set<string>();
        for (let i = replies.length - 1; i >= 0; i--) {
          const a = replies[i].author;
          if (!seen.has(a)) {
            seen.add(a);
            participants.push(a);
          }
        }

        // Orphan root (older than the scan window / undecoded): create a
        // tombstone so the thread is still listed and reachable. The
        // ThreadPanel renders a placeholder for the root; when the real root
        // eventually loads, it replaces the tombstone naturally.
        const rootChatMsg: ChatMsg = rootMsg
          ? openedToChatMsg(rootMsg)
          : makeTombstoneRoot(rootId);

        out.push({
          root: rootChatMsg,
          rootId,
          newestReplyAuthor: newest.author,
          channelIdHex: idHex,
          replyCount: replies.length,
          lastReplyAt: newest.createdAt,
          participants,
        });
      }
    }

    out.sort((a, b) => b.lastReplyAt - a.lastReplyAt);
    return out;
  }, [rumorsByChannel, pubkey, mutedPubkeys, moderation]);

  // Layer per-thread "new" on top as pure arithmetic against the shared
  // read-state map (`c2t:<rootId>` stamps).
  const threads = useMemo<ConcordThread[]>(
    () =>
      scanned.map((t) => ({
        root: t.root,
        channelIdHex: t.channelIdHex,
        replyCount: t.replyCount,
        lastReplyAt: t.lastReplyAt,
        participants: t.participants,
        hasNew:
          t.newestReplyAuthor !== pubkey &&
          t.lastReplyAt > (readState[concordThreadReadKey(t.rootId)] ?? 0),
      })),
    [scanned, readState, pubkey],
  );

  const markRead = useCallback(
    (rootId: string, timestamp: number) => {
      if (timestamp <= 0) return;
      sharedMarkRead(concordThreadReadKey(rootId), timestamp);
    },
    [sharedMarkRead],
  );

  const hasNew = useMemo(() => threads.some((t) => t.hasNew), [threads]);

  // "Mark all as read": advance every currently-loaded thread with unseen
  // replies to its newest reply. Monotonic, like the single-thread `markRead`.
  const markAllRead = useCallback(() => {
    for (const t of threads) {
      if (t.hasNew) markRead(t.root.id, t.lastReplyAt);
    }
  }, [threads, markRead]);

  return useMemo(
    () => ({ threads, isLoading, hasNew, markRead, markAllRead }),
    [threads, isLoading, hasNew, markRead, markAllRead],
  );
}

/**
 * Create a synthetic placeholder `ChatMsg` for a thread root that hasn't been
 * decoded/loaded yet. The ThreadPanel detects tombstone roots (via
 * {@link isTombstoneRoot}) and renders a "message not loaded" placeholder
 * instead of the root's content/avatar. The real root replaces the tombstone
 * naturally once it loads (the next scan picks it up from `byId`).
 */
function makeTombstoneRoot(rootId: string): ChatMsg {
  const ev: NostrEvent = {
    id: rootId,
    pubkey: TOMBSTONE_PUBKEY,
    created_at: 0,
    kind: 9,
    tags: [],
    content: "",
    sig: "",
  };
  return ev;
}
