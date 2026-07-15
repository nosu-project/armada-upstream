import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import { KIND_GROUP_WEBXDC_REALTIME, KIND_GROUP_WEBXDC_UPDATE } from "@/lib/nip29";

import type { AppStateMeta, AppStateUpdate, AppSync } from "@/hooks/useWebxdcApi";
import type { NostrEvent } from "@nostrify/nostrify";

/** Decode a base64 string to a Uint8Array. */
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Encode a Uint8Array to base64. */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/**
 * In-chat app coordination plane for a NIP-29 group, scoped to one app session
 * (`uuid`). State (`sendUpdate`) is kind {@link KIND_GROUP_WEBXDC_UPDATE} and
 * realtime (`joinRealtimeChannel`) is the ephemeral kind
 * {@link KIND_GROUP_WEBXDC_REALTIME}; both carry an `i` tag = `uuid` and the
 * group `h` tag, and publish only to the group's host relay.
 */
export function useGroupAppSync(
  relayUrl: string | undefined,
  groupId: string | undefined,
  uuid: string,
): AppSync {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { mutate: publish } = useNostrPublish();
  const queryClient = useQueryClient();

  const enabled = Boolean(relayUrl && groupId && uuid);
  const queryKey = useMemo(
    () => ["nip29", "app-state", relayUrl, groupId, uuid] as const,
    [relayUrl, groupId, uuid],
  );

  const { data: stateEvents } = useQuery<NostrEvent[]>({
    queryKey,
    enabled,
    // Durable state arrives LIVE via the session subscription below; this poll
    // is only a slow healing backstop for a dropped socket (was an aggressive
    // 3s poll that ran for the whole app session).
    refetchInterval: 60_000,
    queryFn: async ({ signal }) => {
      const events = await nostr
        .relay(relayUrl!)
        .query([{ kinds: [KIND_GROUP_WEBXDC_UPDATE], "#h": [groupId!], "#i": [uuid], limit: 500 }], {
          signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
        })
        .catch(() => [] as NostrEvent[]);
      return events.sort((a, b) => a.created_at - b.created_at);
    },
  });

  const stateUpdates = useMemo((): AppStateUpdate[] => {
    return (stateEvents ?? []).map((event) => {
      let payload: unknown;
      try {
        payload = JSON.parse(event.content);
      } catch {
        payload = event.content;
      }
      return {
        payload,
        info: event.tags.find(([n]) => n === "info")?.[1],
        document: event.tags.find(([n]) => n === "document")?.[1],
        summary: event.tags.find(([n]) => n === "summary")?.[1],
      };
    });
  }, [stateEvents]);

  const sendState = useCallback(
    (payload: unknown, opts?: AppStateMeta) => {
      if (!enabled) return;
      const tags: string[][] = [
        ["h", groupId!],
        ["i", uuid],
        ["alt", "Webxdc update"],
      ];
      if (opts?.info) tags.push(["info", opts.info]);
      if (opts?.document) tags.push(["document", opts.document]);
      if (opts?.summary) tags.push(["summary", opts.summary]);
      publish(
        {
          kind: KIND_GROUP_WEBXDC_UPDATE,
          content: JSON.stringify(payload),
          tags,
          relay: relayUrl,
        },
        {
          onSuccess: () => queryClient.invalidateQueries({ queryKey }),
        },
      );
    },
    [enabled, groupId, uuid, relayUrl, publish, queryClient, queryKey],
  );

  const sendRealtime = useCallback(
    (data: Uint8Array) => {
      if (!enabled) return;
      publish({
        kind: KIND_GROUP_WEBXDC_REALTIME,
        content: bytesToBase64(data),
        tags: [
          ["h", groupId!],
          ["i", uuid],
        ],
        relay: relayUrl,
      });
    },
    [enabled, groupId, uuid, relayUrl, publish],
  );

  // Session subscriptions (mounted only while an app is open): one live `req`
  // for realtime frames (ephemeral, delivered straight to listeners, never
  // stored) and one for durable state updates (merged into the query cache so
  // app state arrives live instead of on a poll). Deliberately NOT on the
  // always-on wire — a webxdc session is single, ephemeral, and latency-
  // sensitive; the wire is for ambient timeline/control ingestion.
  const listenersRef = useRef(new Set<(data: Uint8Array) => void>());
  const selfPubkey = user?.pubkey;

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const since = Math.floor(Date.now() / 1000);

    // Realtime frames → listeners.
    (async () => {
      try {
        for await (const msg of nostr.relay(relayUrl!).req(
          [{ kinds: [KIND_GROUP_WEBXDC_REALTIME], "#h": [groupId!], "#i": [uuid], since }],
          { signal: controller.signal },
        )) {
          if (msg[0] === "EVENT") {
            const event = msg[2] as NostrEvent;
            if (event.pubkey === selfPubkey) continue;
            try {
              const bytes = base64ToBytes(event.content);
              for (const cb of listenersRef.current) cb(bytes);
            } catch {
              // ignore malformed
            }
          } else if (msg[0] === "CLOSED") {
            break;
          }
        }
      } catch {
        // subscription ended (abort/error)
      }
    })();

    // Durable state updates → query cache (live, deduped by id).
    (async () => {
      try {
        for await (const msg of nostr.relay(relayUrl!).req(
          [{ kinds: [KIND_GROUP_WEBXDC_UPDATE], "#h": [groupId!], "#i": [uuid], since }],
          { signal: controller.signal },
        )) {
          if (msg[0] === "EVENT") {
            const event = msg[2] as NostrEvent;
            queryClient.setQueryData<NostrEvent[]>(queryKey, (old) => {
              if (old?.some((e) => e.id === event.id)) return old;
              return [...(old ?? []), event].sort((a, b) => a.created_at - b.created_at);
            });
          } else if (msg[0] === "CLOSED") {
            break;
          }
        }
      } catch {
        // subscription ended (abort/error)
      }
    })();

    return () => controller.abort();
  }, [enabled, nostr, relayUrl, groupId, uuid, selfPubkey, queryClient, queryKey]);

  const onRealtime = useCallback((cb: (data: Uint8Array) => void) => {
    listenersRef.current.add(cb);
    return () => {
      listenersRef.current.delete(cb);
    };
  }, []);

  return useMemo<AppSync>(
    () => ({ stateUpdates, sendState, sendRealtime, onRealtime }),
    [stateUpdates, sendState, sendRealtime, onRealtime],
  );
}
