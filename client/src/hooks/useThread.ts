import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";

import { useNostrPublish } from "@/hooks/useNostrPublish";
import { buildCommentTags, KIND_COMMENT } from "@/lib/nip29";

import type { NostrEvent } from "@nostrify/nostrify";

function threadKey(relayUrl: string, rootId: string | undefined) {
  return ["thread", relayUrl, rootId] as const;
}

/**
 * Load and post threaded replies (NIP-22 kind 1111 comments) for a root chat
 * message inside a NIP-29 group. Replies are queried from and published to the
 * group's host relay only, mirroring chat messages and reactions.
 *
 * The whole thread is fetched by the root's uppercase `#E` tag, so replies at
 * any nesting depth are included; we sort ascending by `created_at` for a
 * chat-style transcript. A live subscription appends new replies into the
 * cache (replacing the previous 30s polling), so a thread updates instantly
 * while it's open.
 */
export function useThread(root: NostrEvent | undefined, relayUrl: string, groupId: string) {
  const { nostr } = useNostr();
  const { mutateAsync: createEvent, isPending: isSending } = useNostrPublish();
  const queryClient = useQueryClient();
  const queryKey = threadKey(relayUrl, root?.id);

  const repliesQuery = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      return await nostr.relay(relayUrl).query(
        // The `#h` group tag is REQUIRED here, not just `#E`: relay29's
        // NormalEventQuery only serves filters carrying an `h`/`e`/`a`/`ids`
        // selector (uppercase `#E` alone matches none), so without `#h` the
        // relay accepts the kind-1111 replies on write but returns nothing on
        // read — replies silently never load.
        [{ kinds: [KIND_COMMENT], "#E": [root!.id], "#h": [groupId], limit: 500 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
      );
    },
    enabled: Boolean(root),
    staleTime: 15_000,
  });

  // Live subscription: append new replies as they arrive (replaces polling).
  useEffect(() => {
    if (!root) return;
    const controller = new AbortController();
    const rootId = root.id;

    (async () => {
      try {
        for await (const msg of nostr.relay(relayUrl).req(
          [
            {
              kinds: [KIND_COMMENT],
              "#E": [rootId],
              "#h": [groupId],
              since: Math.floor(Date.now() / 1000) - 5,
            },
          ],
          { signal: controller.signal },
        )) {
          if (msg[0] !== "EVENT") continue;
          const event = msg[2] as NostrEvent;
          queryClient.setQueryData<NostrEvent[]>(threadKey(relayUrl, rootId), (old = []) =>
            old.some((e) => e.id === event.id) ? old : [...old, event],
          );
          // Keep the parent message's "N replies" badge in sync (the batched
          // reply-count query also has its own live sub, but nudge it too).
          queryClient.invalidateQueries({ queryKey: ["nip29", "reply-counts", relayUrl, groupId] });
        }
      } catch {
        // Subscription ended (abort or relay closed).
      }
    })();

    return () => controller.abort();
  }, [nostr, root, relayUrl, groupId, queryClient]);

  // De-duplicate by id and order oldest-first for a readable transcript.
  const replies = useMemo<NostrEvent[]>(() => {
    const byId = new Map<string, NostrEvent>();
    for (const reply of repliesQuery.data ?? []) byId.set(reply.id, reply);
    return [...byId.values()].sort((a, b) => a.created_at - b.created_at);
  }, [repliesQuery.data]);

  const sendReply = useMutation({
    mutationFn: async (content: string) => {
      if (!root) throw new Error("No thread root");
      await createEvent({
        kind: KIND_COMMENT,
        content,
        tags: buildCommentTags(root, groupId),
        relay: relayUrl,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      // The reply-count badge reads the batched group reply-count query.
      queryClient.invalidateQueries({ queryKey: ["nip29", "reply-counts", relayUrl, groupId] });
    },
  });

  return {
    replies,
    isLoading: repliesQuery.isLoading,
    sendReply: (content: string) => sendReply.mutateAsync(content),
    isSending: isSending || sendReply.isPending,
  };
}

/**
 * Threaded-reply counts for a whole group's visible messages, in ONE batched
 * query keyed by the root ids in view. Replaces the previous per-message
 * `useReplyCount` (one `limit:500` relay query PER message, re-polled every 60s)
 * with a single query for all replies referencing any loaded message, tallied
 * into a `Map<rootId, count>` and exposed via `replyCountFor(id)`.
 *
 * Replies (NIP-22 kind 1111) name their root via the uppercase `#E` tag, so we
 * query all roots at once (`#h` is REQUIRED for relay29 to serve the filter —
 * see {@link useThread}) and bucket the results by their `E` tag. A single live
 * subscription folds in new replies so counts stay current without polling.
 */
export function useGroupReplyCounts(
  relayUrl: string | undefined,
  groupId: string | undefined,
  messageIds: string[],
): { replyCountFor: (id: string) => number } {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const queryKey = ["nip29", "reply-counts", relayUrl, groupId] as const;

  // Stable primitive dep for the id set (not a fresh array each render).
  const idsSig = useMemo(() => [...messageIds].sort().join(","), [messageIds]);

  const query = useQuery<Map<string, Set<string>>>({
    queryKey,
    queryFn: async ({ signal }) => {
      const ids = idsSig ? idsSig.split(",") : [];
      if (!relayUrl || !groupId || ids.length === 0) return new Map();
      const events = await nostr.relay(relayUrl).query(
        // `#h` is required for relay29 to serve the query (see useThread).
        [{ kinds: [KIND_COMMENT], "#E": ids, "#h": [groupId], limit: ids.length * 20 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
      );
      return bucketReplies(events);
    },
    enabled: Boolean(relayUrl && groupId) && Boolean(idsSig),
    staleTime: 30_000,
  });

  // One live subscription for the whole group's threads (replaces per-message
  // polling), so a new reply bumps its root's badge instantly.
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
          queryClient.setQueryData<Map<string, Set<string>>>(queryKey, (old) => {
            const next = new Map<string, Set<string>>();
            if (old) for (const [k, v] of old) next.set(k, new Set(v));
            for (const [, root] of event.tags.filter(([n]) => n === "E")) {
              if (!root) continue;
              const set = next.get(root) ?? new Set<string>();
              set.add(event.id);
              next.set(root, set);
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
    (id: string) => query.data?.get(id)?.size ?? 0,
    [query.data],
  );

  return { replyCountFor };
}

/** Bucket kind-1111 replies by their root id (`#E` tag), de-duped by reply id. */
function bucketReplies(events: NostrEvent[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const event of events) {
    for (const [, root] of event.tags.filter(([n]) => n === "E")) {
      if (!root) continue;
      const set = out.get(root) ?? new Set<string>();
      set.add(event.id);
      out.set(root, set);
    }
  }
  return out;
}
