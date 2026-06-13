import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { KIND_GROUP_CHAT } from "@/lib/nip29";

import type { NostrEvent } from "@nostrify/nostrify";

/** NIP-88 poll kind — polls posted to the group render in the timeline. */
const KIND_POLL = 1068;

/** Event kinds shown in the group timeline. */
const TIMELINE_KINDS = [KIND_GROUP_CHAT, KIND_POLL];

/**
 * Chat messages (kind 9) and polls (kind 1068) for a NIP-29 group, with a
 * live subscription that appends incoming messages into the query cache.
 *
 * Ported from Ditto's LiveStreamChat pattern (kind 1311/`#a` → kind 9/`#h`),
 * targeted at the group's host relay only.
 */
export function useGroupMessages(relayUrl: string | undefined, groupId: string | undefined) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();

  const queryKey = ["nip29", "messages", relayUrl, groupId];

  const query = useQuery<NostrEvent[]>({
    queryKey,
    queryFn: async ({ signal }) => {
      const events = await nostr.relay(relayUrl!).query(
        [{ kinds: TIMELINE_KINDS, "#h": [groupId!], limit: 200 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
      );
      return events.sort((a, b) => a.created_at - b.created_at);
    },
    enabled: Boolean(relayUrl && groupId),
    staleTime: 10_000,
  });

  // Live subscription for new messages.
  useEffect(() => {
    if (!relayUrl || !groupId) return;
    const controller = new AbortController();

    (async () => {
      try {
        for await (const msg of nostr.relay(relayUrl).req(
          [{ kinds: TIMELINE_KINDS, "#h": [groupId], since: Math.floor(Date.now() / 1000) - 5 }],
          { signal: controller.signal },
        )) {
          if (msg[0] === "EVENT") {
            const event = msg[2] as NostrEvent;
            queryClient.setQueryData<NostrEvent[]>(["nip29", "messages", relayUrl, groupId], (old = []) => {
              if (old.some((e) => e.id === event.id)) return old;
              return [...old, event].sort((a, b) => a.created_at - b.created_at);
            });
          }
        }
      } catch {
        // Subscription ended (abort or relay closed).
      }
    })();

    return () => controller.abort();
  }, [nostr, relayUrl, groupId, queryClient]);

  return query;
}
