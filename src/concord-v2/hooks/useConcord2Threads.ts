import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useCommunityRumors } from "@/concord-v2/hooks/useCommunityRumors";
import { foldTimeline, replyTargetOf, type OpenedChat } from "@/concord-v2/lib/chat";
import { openedToChatMsg } from "@/concord-v2/hooks/useTransport2";
import type { ChannelV2 } from "@/concord-v2/lib/types";
import type { ChatMsg } from "@/components/chat/transport";
import {
  loadConcord2ThreadReadState,
  markConcord2ThreadRead,
  markConcord2ThreadsRead,
  type Concord2ThreadReadMap,
} from "@/concord-v2/lib/threadReadState2";

/** A thread the current user has participated in, summarized for the tab. */
export interface Concord2Thread {
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

/** Shared TanStack key for the per-user thread read map. */
const threadReadMapKey = (pubkey: string | undefined) =>
  ["concord2-thread-read-map", pubkey] as const;

/**
 * Threads the current user has participated in across a Concord V2 community —
 * every thread whose root or any reply they authored — summarized newest-reply
 * first, derived PURELY from the shared community rumor scan
 * ({@link useCommunityRumors}). No store access of its own.
 *
 * "New" is per-thread: a thread lights up when its newest reply is newer than
 * the last time the user opened it (tracked in {@link threadReadState2}) and
 * isn't their own. The per-thread read comparison is pure computation layered
 * over the shared scan, so `markRead` recomputes instantly without re-reading.
 */
export function useConcord2Threads(channels: ChannelV2[]): {
  threads: Concord2Thread[];
  isLoading: boolean;
  hasNew: boolean;
  markRead: (rootId: string, timestamp: number) => void;
  markAllRead: () => void;
} {
  const { user } = useCurrentUser();
  const pubkey = user?.pubkey;
  const queryClient = useQueryClient();

  const channelSig = channels.map((c) => c.idHex).join(",");
  const channelIds = useMemo(() => channels.map((c) => c.idHex), [channelSig]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data: readMap = {} } = useQuery<Concord2ThreadReadMap>({
    queryKey: threadReadMapKey(pubkey),
    queryFn: () => loadConcord2ThreadReadState(pubkey!),
    enabled: !!pubkey,
    staleTime: Infinity,
  });

  const { byChannel: rumorsByChannel, isLoading } = useCommunityRumors(channelIds);

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
      const messages = foldTimeline(rumors).messages;
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
        // Orphan root (older than the scan window / undecoded): no root to
        // render or open a panel for.
        if (!rootMsg) continue;
        const authoredRoot = rootMsg.author === pubkey;
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

        out.push({
          root: openedToChatMsg(rootMsg),
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
  }, [rumorsByChannel, pubkey]);

  // Layer per-thread "new" on top as pure arithmetic against the read map.
  const threads = useMemo<Concord2Thread[]>(
    () =>
      scanned.map((t) => ({
        root: t.root,
        channelIdHex: t.channelIdHex,
        replyCount: t.replyCount,
        lastReplyAt: t.lastReplyAt,
        participants: t.participants,
        hasNew: t.newestReplyAuthor !== pubkey && t.lastReplyAt > (readMap[t.rootId] ?? 0),
      })),
    [scanned, readMap, pubkey],
  );

  const markRead = useCallback(
    (rootId: string, timestamp: number) => {
      if (!pubkey || timestamp <= 0) return;
      queryClient.setQueryData<Concord2ThreadReadMap>(threadReadMapKey(pubkey), (prev = {}) =>
        (prev[rootId] ?? 0) >= timestamp ? prev : { ...prev, [rootId]: timestamp },
      );
      void markConcord2ThreadRead(pubkey, rootId, timestamp).then((map) => {
        queryClient.setQueryData(threadReadMapKey(pubkey), map);
      });
    },
    [pubkey, queryClient],
  );

  const hasNew = useMemo(() => threads.some((t) => t.hasNew), [threads]);

  // "Mark all as read": advance every currently-loaded thread with unseen
  // replies to its newest reply, in ONE batched write (not N debounced ones).
  // Monotonic, like the single-thread `markRead`.
  const markAllRead = useCallback(() => {
    if (!pubkey) return;
    const entries = threads
      .filter((t) => t.hasNew)
      .map((t) => [t.root.id, t.lastReplyAt] as const);
    if (entries.length === 0) return;
    queryClient.setQueryData<Concord2ThreadReadMap>(threadReadMapKey(pubkey), (prev = {}) => {
      let next: Concord2ThreadReadMap | undefined;
      for (const [rootId, ts] of entries) {
        if ((prev[rootId] ?? 0) >= ts) continue;
        next ??= { ...prev };
        next[rootId] = ts;
      }
      return next ?? prev;
    });
    void markConcord2ThreadsRead(pubkey, entries).then((map) => {
      queryClient.setQueryData(threadReadMapKey(pubkey), map);
    });
  }, [pubkey, threads, queryClient]);

  return useMemo(
    () => ({ threads, isLoading, hasNew, markRead, markAllRead }),
    [threads, isLoading, hasNew, markRead, markAllRead],
  );
}
