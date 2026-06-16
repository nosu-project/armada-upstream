import { useNostr } from "@nostrify/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

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
          // Keep the parent message's "N replies" badge in sync.
          queryClient.invalidateQueries({ queryKey: ["thread-count", relayUrl, rootId] });
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
      // The reply-count badge on the parent message reads a sibling query.
      queryClient.invalidateQueries({ queryKey: ["thread-count", relayUrl, root?.id] });
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
 * The number of threaded replies to a message, for the inline "N replies"
 * badge. A lightweight count-only query per message (one request each, as with
 * reactions) so the badge can render without opening the thread panel.
 */
export function useReplyCount(eventId: string, relayUrl: string, groupId: string) {
  const { nostr } = useNostr();

  const { data = 0 } = useQuery({
    queryKey: ["thread-count", relayUrl, eventId],
    queryFn: async ({ signal }) => {
      const events = await nostr.relay(relayUrl).query(
        // `#h` is required for relay29 to serve the query (see useThread).
        [{ kinds: [KIND_COMMENT], "#E": [eventId], "#h": [groupId], limit: 500 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
      );
      return new Set(events.map((e) => e.id)).size;
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  return data;
}
