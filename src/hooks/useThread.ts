import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";

import { useNostrPublish } from "@/hooks/useNostrPublish";
import { buildCommentTags, KIND_COMMENT } from "@/lib/nip29";

import { toChatMsg } from "@/components/chat/transport";
import type { ChatMsg } from "@/components/chat/transport";
import type { NostrEvent } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";

/**
 * Replies and counts for all visible messages in ONE batched query plus one live subscription,
 * exposed via `replyCountFor(id)` / `threadRepliesFor(id)`. NIP-22 kind-1111 replies name their root
 * in `#E`; `#h` is REQUIRED because relay29 serves no filter with uppercase `#E` alone.
 */
export function useGroupThreads(
  relayUrl: string | undefined,
  groupId: string | undefined,
  messageIds: string[],
): {
  replyCountFor: (id: string) => number;
  threadRepliesFor: (rootId: string) => ChatMsg[];
} {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const queryKey = ["nip29", "reply-counts", relayUrl, groupId] as const;

  const idsSig = useMemo(() => [...messageIds].sort().join(","), [messageIds]);

  const query = useQuery<Map<string, NostrRumor[]>>({
    queryKey,
    queryFn: async ({ signal }) => {
      const ids = idsSig ? idsSig.split(",") : [];
      if (!relayUrl || !groupId || ids.length === 0) return new Map();
      const events = await nostr.relay(relayUrl).query(
        // `#h` is required for relay29 to serve the query (see the JSDoc above).
        [{ kinds: [KIND_COMMENT], "#E": ids, "#h": [groupId], limit: ids.length * 20 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
      );
      return bucketReplies(events);
    },
    enabled: Boolean(relayUrl && groupId) && Boolean(idsSig),
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!relayUrl || !groupId || !idsSig) return;
    const ids = idsSig.split(",");
    const controller = new AbortController();

    (async () => {
      try {
        for await (const msg of nostr.relay(relayUrl).req(
          [{ kinds: [KIND_COMMENT], "#E": ids, "#h": [groupId], since: Math.floor(Date.now() / 1000) - 5 }],
          { signal: controller.signal },
        )) {
          if (msg[0] !== "EVENT") continue;
          const event = msg[2] as NostrEvent;
          queryClient.setQueryData<Map<string, NostrRumor[]>>(queryKey, (old) => {
            const next = new Map<string, NostrRumor[]>();
            if (old) for (const [k, v] of old) next.set(k, v);
            for (const [, root] of event.tags.filter(([n]) => n === "E")) {
              if (!root) continue;
              const list = next.get(root) ?? [];
              if (!list.some((e) => e.id === event.id)) next.set(root, [...list, event]);
            }
            return next;
          });
        }
      } catch {
        // Subscription ended (abort or relay closed).
      }
    })();

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nostr, relayUrl, groupId, idsSig, queryClient]);

  const replyCountFor = useCallback(
    (id: string) => query.data?.get(id)?.length ?? 0,
    [query.data],
  );

  // Identity-cached so unchanged threads keep stable references for React.memo.
  const adapted = useMemo(() => {
    const out = new Map<string, ChatMsg[]>();
    for (const [rootId, events] of query.data ?? []) {
      const sorted = [...events].sort((a, b) => a.created_at - b.created_at);
      out.set(rootId, sorted.map((e) => toChatMsg(e)));
    }
    return out;
  }, [query.data]);

  const threadRepliesFor = useCallback(
    (rootId: string): ChatMsg[] => adapted.get(rootId) ?? EMPTY_REPLIES,
    [adapted],
  );

  return { replyCountFor, threadRepliesFor };
}

const EMPTY_REPLIES: ChatMsg[] = [];

/**
 * Post a NIP-22 kind-1111 reply to the host relay; the live subscription folds the echo back,
 * so no optimistic insert. `composerTags` (mentions, hashtags, emoji, imeta, quotes) are merged
 * into the comment skeleton, minus `h`/`e` and duplicate `p`s.
 */
export function useSendThreadReply(relayUrl: string, groupId: string) {
  const { mutateAsync: createEvent } = useNostrPublish();
  const queryClient = useQueryClient();
  return useCallback(
    async (root: NostrRumor, content: string, composerTags: string[][] = []) => {
      const tags = buildCommentTags(root, groupId);
      for (const tag of composerTags) {
        // Thread structure comes from buildCommentTags; the composer's variants would conflict.
        if (tag[0] === "h" || tag[0] === "e") continue;
        // De-dupe mention p tags against the parent-author p tag.
        if (tag[0] === "p" && tags.some(([n, v]) => n === "p" && v === tag[1])) continue;
        tags.push(tag);
      }
      await createEvent({
        kind: KIND_COMMENT,
        content,
        tags,
        relay: relayUrl,
      });
      queryClient.invalidateQueries({ queryKey: ["nip29", "reply-counts", relayUrl, groupId] });
    },
    [createEvent, queryClient, relayUrl, groupId],
  );
}

/** De-duped by reply id. */
function bucketReplies(events: NostrRumor[]): Map<string, NostrRumor[]> {
  const out = new Map<string, NostrRumor[]>();
  const seen = new Map<string, Set<string>>();
  for (const event of events) {
    for (const [, root] of event.tags.filter(([n]) => n === "E")) {
      if (!root) continue;
      const ids = seen.get(root) ?? new Set<string>();
      if (ids.has(event.id)) continue;
      ids.add(event.id);
      seen.set(root, ids);
      const list = out.get(root) ?? [];
      list.push(event);
      out.set(root, list);
    }
  }
  return out;
}
