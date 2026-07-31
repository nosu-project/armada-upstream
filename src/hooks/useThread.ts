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
 * Threaded replies + counts for a whole group's visible messages, in ONE
 * batched query keyed by the root ids in view. Replaces the previous
 * per-message `useReplyCount` (one `limit:500` relay query PER
 * message) with a single query for all replies referencing any loaded message,
 * bucketed by root id and exposed via `replyCountFor(id)` +
 * `threadRepliesFor(id)`. A single live subscription folds in new replies so
 * counts and open threads stay current without polling.
 *
 * Replies (NIP-22 kind 1111) name their root via the uppercase `#E` tag, so we
 * query all roots at once (the `#h` group tag is REQUIRED for relay29 to serve
 * the filter — relay29's NormalEventQuery only serves filters carrying an
 * `h`/`e`/`a`/`ids` selector; uppercase `#E` alone matches none, so without
 * `#h` the relay accepts kind-1111 replies on write but returns nothing on
 * read) and bucket the results by their `E` tag.
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

  // Stable primitive dep for the id set (not a fresh array each render).
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

  // One live subscription for the whole group's threads (replaces per-message
  // polling), so a new reply bumps its root's badge + open thread instantly.
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

  // Identity-cached adaptation so an unchanged thread keeps a stable array (and
  // stable per-message references) across re-renders, letting React.memo skip
  // untouched rows in the panel.
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

/** Stable empty array so a thread with no replies keeps a constant reference. */
const EMPTY_REPLIES: ChatMsg[] = [];

/**
 * Post a threaded reply (NIP-22 kind 1111 comment) to a root chat message
 * inside a NIP-29 group, publishing to the group's host relay. The batched
 * {@link useGroupThreads} live subscription folds the echo back into the open
 * thread + reply-count badge, so no local optimistic insert is needed.
 *
 * `composerTags` are the content-derived tags the shared composer built for
 * the reply (NIP-27 mention `p` tags, `t` hashtags, NIP-30 `emoji`, NIP-92
 * `imeta`, NIP-18 `q` quotes). They are merged into the NIP-22 comment
 * skeleton — dropping the composer's own `h`/`e` structure (the comment tags
 * carry the group + thread pointers) and de-duplicating `p` tags — so
 * @-mentions in thread replies actually tag (and notify) the mentioned users.
 */
export function useSendThreadReply(relayUrl: string, groupId: string) {
  const { mutateAsync: createEvent } = useNostrPublish();
  const queryClient = useQueryClient();
  return useCallback(
    async (root: NostrRumor, content: string, composerTags: string[][] = []) => {
      const tags = buildCommentTags(root, groupId);
      for (const tag of composerTags) {
        // Thread structure (`h` group, `e` pointers) comes from
        // buildCommentTags; the composer's variants would conflict.
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

/** Bucket kind-1111 replies by their root id (`#E` tag), de-duped by reply id. */
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
