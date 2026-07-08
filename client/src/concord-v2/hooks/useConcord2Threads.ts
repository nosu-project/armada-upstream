import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { queryChannelRumors } from "@/concord-v2/lib/rumorStore";
import { foldTimeline, type OpenedChat } from "@/concord-v2/lib/chat";
import { openedToChatMsg } from "@/concord-v2/hooks/useTransport2";
import type { ChannelV2 } from "@/concord-v2/lib/types";
import type { ChatMsg } from "@/components/chat/transport";
import {
  loadConcord2ThreadReadState,
  markConcord2ThreadRead,
  type Concord2ThreadReadMap,
} from "@/concord-v2/lib/threadReadState2";
import { useWireScopes } from "@/wire/useWireScopes";

/** How many newest cached rumors to fold per channel when scanning threads. */
const SCAN_LIMIT = 200;

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
 * every thread whose ROOT or any reply they authored — summarized newest-reply
 * first, purely from the local decrypted rumor cache (IndexedDB). No relay
 * query is made: the wire keeps every channel's cache fed, so this scan folds
 * each channel's cached rumors (applying edits/deletes), buckets replies by
 * their `q` root, and keeps the threads the user is in.
 *
 * "New" is per-thread (not per-channel like {@link useConcord2Unread}): a
 * thread lights up when its newest reply is newer than the last time the user
 * opened it (tracked in {@link threadReadState2}) and isn't their own. Modeled
 * on {@link useConcord2Mentions}: shared query cache keyed by pubkey + channel
 * set, re-scanned on the wire bus, light poll as a backstop.
 *
 * `markRead(rootId, ts)` advances a thread's read stamp (call when the user
 * opens the thread panel).
 */
export function useConcord2Threads(channels: ChannelV2[]): {
  threads: Concord2Thread[];
  isLoading: boolean;
  hasNew: boolean;
  markRead: (rootId: string, timestamp: number) => void;
} {
  const { user } = useCurrentUser();
  const pubkey = user?.pubkey;
  const queryClient = useQueryClient();

  const channelSig = channels.map((c) => c.idHex).join(",");
  const channelIds = useMemo(() => channels.map((c) => c.idHex), [channelSig]); // eslint-disable-line react-hooks/exhaustive-deps

  // The persisted per-thread read map, shared across mounts via the query cache
  // (so `markRead` from the open panel updates the tab's badge instantly).
  const { data: readMap = {} } = useQuery<Concord2ThreadReadMap>({
    queryKey: threadReadMapKey(pubkey),
    queryFn: () => loadConcord2ThreadReadState(pubkey!),
    enabled: !!pubkey,
    staleTime: Infinity,
  });

  const { data: threads = [], isLoading } = useQuery<Concord2Thread[]>({
    queryKey: ["concord2-threads", pubkey, channelSig, readMap],
    queryFn: async () => {
      const perChannel = await Promise.all(
        channelIds.map(async (idHex) => {
          try {
            const rumors = await queryChannelRumors(idHex, { limit: SCAN_LIMIT });
            return { idHex, messages: foldTimeline(rumors).messages };
          } catch {
            return { idHex, messages: [] as OpenedChat[] };
          }
        }),
      );

      const out: Concord2Thread[] = [];
      for (const { idHex, messages } of perChannel) {
        const byId = new Map(messages.map((m) => [m.rumorId, m]));
        // Bucket replies (kind-9 with a `q` root) by their thread root.
        const repliesByRoot = new Map<string, OpenedChat[]>();
        for (const m of messages) {
          const root = m.tags.find((t) => t[0] === "q")?.[1];
          if (!root) continue;
          const list = repliesByRoot.get(root) ?? [];
          list.push(m);
          repliesByRoot.set(root, list);
        }

        for (const [rootId, replies] of repliesByRoot) {
          const rootMsg = byId.get(rootId);
          // Orphan root (older than the scan window / undecoded): skip — we
          // have no root to render or open a panel for.
          if (!rootMsg) continue;
          const authoredRoot = rootMsg.author === pubkey;
          const authoredReply = replies.some((r) => r.author === pubkey);
          if (!authoredRoot && !authoredReply) continue;

          replies.sort((a, b) => a.ms - b.ms);
          const newest = replies[replies.length - 1];
          const lastReplyAt = newest.createdAt;

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

          const lastRead = readMap[rootId] ?? 0;
          const hasNew = newest.author !== pubkey && lastReplyAt > lastRead;

          out.push({
            root: openedToChatMsg(rootMsg),
            channelIdHex: idHex,
            replyCount: replies.length,
            lastReplyAt,
            participants,
            hasNew,
          });
        }
      }

      out.sort((a, b) => b.lastReplyAt - a.lastReplyAt);
      return out;
    },
    enabled: !!pubkey && channelIds.length > 0,
    refetchInterval: 30_000,
    staleTime: 0,
  });

  useWireScopes((scopes) => {
    for (const idHex of channelIds) {
      if (scopes.has(`c2:${idHex}`)) {
        void queryClient.invalidateQueries({ queryKey: ["concord2-threads", pubkey] });
        return;
      }
    }
  });

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

  return useMemo(
    () => ({ threads, isLoading, hasNew, markRead }),
    [threads, isLoading, hasNew, markRead],
  );
}
