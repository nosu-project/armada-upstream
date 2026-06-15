import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";

import { KIND_GROUP_CHAT } from "@/lib/nip29";

import type { NostrEvent } from "@nostrify/nostrify";

/** NIP-88 poll kind — polls posted to the group render in the timeline. */
const KIND_POLL = 1068;
/** NIP-09 deletion kind. */
const KIND_DELETE = 5;

/** Event kinds shown in the group timeline. */
const TIMELINE_KINDS = [KIND_GROUP_CHAT, KIND_POLL];
/** Kinds the live subscription watches (timeline + deletions). */
const LIVE_KINDS = [KIND_GROUP_CHAT, KIND_POLL, KIND_DELETE];

/** Delivery status of an optimistically-inserted (locally-published) message. */
export type SendStatus = "pending" | "failed";

/** Map of event id → send status, for optimistic/unconfirmed messages. */
export type SendStatusMap = Record<string, SendStatus>;

function messagesKey(relayUrl: string | undefined, groupId: string | undefined) {
  return ["nip29", "messages", relayUrl, groupId] as const;
}

function statusKey(relayUrl: string | undefined, groupId: string | undefined) {
  return ["nip29", "msg-status", relayUrl, groupId] as const;
}

/**
 * Chat messages (kind 9) and polls (kind 1068) for a NIP-29 group, with a
 * live subscription that appends incoming messages into the query cache.
 *
 * Supports optimistic publishing: locally-signed messages can be inserted
 * immediately with a `pending` status (and later reconciled to confirmed when
 * the relay echoes the event back, or marked `failed` for retry). Because we
 * sign locally, the optimistic event shares its final id with the relay echo,
 * so de-duplication is automatic.
 *
 * Ported from Ditto's LiveStreamChat pattern (kind 1311/`#a` → kind 9/`#h`),
 * targeted at the group's host relay only.
 */
export function useGroupMessages(relayUrl: string | undefined, groupId: string | undefined) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();

  const query = useQuery<NostrEvent[]>({
    queryKey: messagesKey(relayUrl, groupId),
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

  // Send-status for optimistic messages (kept in its own cache entry).
  const { data: status = {} } = useQuery<SendStatusMap>({
    queryKey: statusKey(relayUrl, groupId),
    queryFn: () => ({}),
    enabled: Boolean(relayUrl && groupId),
    staleTime: Infinity,
    gcTime: Infinity,
  });

  const upsertMessage = useCallback(
    (event: NostrEvent) => {
      queryClient.setQueryData<NostrEvent[]>(messagesKey(relayUrl, groupId), (old = []) => {
        if (old.some((e) => e.id === event.id)) return old;
        return [...old, event].sort((a, b) => a.created_at - b.created_at);
      });
    },
    [queryClient, relayUrl, groupId],
  );

  const setStatus = useCallback(
    (id: string, value: SendStatus | undefined) => {
      queryClient.setQueryData<SendStatusMap>(statusKey(relayUrl, groupId), (old = {}) => {
        if (value === undefined) {
          if (!(id in old)) return old;
          const next = { ...old };
          delete next[id];
          return next;
        }
        if (old[id] === value) return old;
        return { ...old, [id]: value };
      });
    },
    [queryClient, relayUrl, groupId],
  );

  /** Insert a locally-signed message immediately with `pending` status. */
  const insertOptimistic = useCallback(
    (event: NostrEvent) => {
      upsertMessage(event);
      setStatus(event.id, "pending");
    },
    [upsertMessage, setStatus],
  );

  /** Confirm a message delivered (clears its pending/failed status). */
  const markSent = useCallback((id: string) => setStatus(id, undefined), [setStatus]);

  /** Mark a message as failed to send (offers retry in the UI). */
  const markFailed = useCallback((id: string) => setStatus(id, "failed"), [setStatus]);

  /** Remove an optimistic message entirely (e.g. discard a failed send). */
  const removeOptimistic = useCallback(
    (id: string) => {
      queryClient.setQueryData<NostrEvent[]>(messagesKey(relayUrl, groupId), (old = []) =>
        old.filter((e) => e.id !== id),
      );
      setStatus(id, undefined);
    },
    [queryClient, relayUrl, groupId, setStatus],
  );

  // Live subscription for new messages. A relay echo of our own optimistic
  // event arrives here and clears its pending status (same id).
  useEffect(() => {
    if (!relayUrl || !groupId) return;
    const controller = new AbortController();

    (async () => {
      try {
        for await (const msg of nostr.relay(relayUrl).req(
          [{ kinds: LIVE_KINDS, "#h": [groupId], since: Math.floor(Date.now() / 1000) - 5 }],
          { signal: controller.signal },
        )) {
          if (msg[0] === "EVENT") {
            const event = msg[2] as NostrEvent;
            if (event.kind === KIND_DELETE) {
              // NIP-09: drop any referenced messages from the timeline. The
              // relay already removed them from its store; this updates the
              // live cache (e.g. another client edited/deleted a message).
              for (const [name, id] of event.tags) {
                if (name === "e" && id) removeOptimistic(id);
              }
              continue;
            }
            upsertMessage(event);
            setStatus(event.id, undefined);
          }
        }
      } catch {
        // Subscription ended (abort or relay closed).
      }
    })();

    return () => controller.abort();
  }, [nostr, relayUrl, groupId, upsertMessage, setStatus, removeOptimistic]);

  const helpers = useMemo(
    () => ({ status, insertOptimistic, markSent, markFailed, removeOptimistic }),
    [status, insertOptimistic, markSent, markFailed, removeOptimistic],
  );

  return { ...query, ...helpers };
}
