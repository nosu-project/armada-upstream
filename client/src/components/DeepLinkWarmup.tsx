import { useNostr } from "@nostrify/react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { onColdLaunchResolved, peekColdLaunchDeepLink } from "@/lib/coldLaunchDeepLink";
import { routeParamToRelay } from "@/lib/platform";

import type { NostrEvent } from "@nostrify/nostrify";

/** Kinds a group timeline renders (mirrors useGroupMessages). */
const TIMELINE_KINDS = [9, 1068];
/** Mirrors useGroupMessages' PAGE_SIZE — the first page the room will want. */
const PAGE_SIZE = 30;

/** Sort ascending (oldest-first) and de-duplicate a message list by id. */
function sortDedupe(events: NostrEvent[]): NostrEvent[] {
  const byId = new Map<string, NostrEvent>();
  for (const e of events) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => a.created_at - b.created_at);
}

/**
 * Cold-launch warmup for a notification deep link (headless, native-only in
 * practice — the web has no launch URL).
 *
 * As soon as the launch URL resolves to a NIP-29 room path, this opens the
 * room's host relay and requests its newest page — OVERLAPPING the WebSocket
 * connect + NIP-42 AUTH handshake and the first REQ with React still mounting
 * the route, instead of starting all of that only after GroupPage's query
 * runs. Results are merged append-only into the room's query cache (and
 * mirrored to IndexedDB by the batcher), so by the time the timeline mounts,
 * the fresh page is usually already there.
 *
 * Warm (appUrlOpen) navigations don't need this: the app is already running
 * with hot sockets and caches.
 */
export function DeepLinkWarmup() {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();

  useEffect(() => {
    return onColdLaunchResolved(() => {
      const path = peekColdLaunchDeepLink();
      if (!path) return;
      // NIP-29 room: /s/<server>/<groupId>
      const m = path.match(/^\/s\/([^/]+)\/([^/?#]+)/);
      if (!m) return;
      const relayUrl = routeParamToRelay(decodeURIComponent(m[1]));
      const groupId = decodeURIComponent(m[2]);
      if (!relayUrl || !groupId) return;

      void (async () => {
        try {
          const events = await nostr.relay(relayUrl).query(
            [{ kinds: TIMELINE_KINDS, "#h": [groupId], limit: PAGE_SIZE }],
            { signal: AbortSignal.timeout(8000) },
          );
          if (events.length === 0) return;
          queryClient.setQueryData<NostrEvent[]>(
            ["nip29", "messages", relayUrl, groupId],
            (old = []) => sortDedupe([...old, ...events]),
          );
        } catch {
          // Best-effort: the room's own local-first query still loads normally.
        }
      })();
    });
  }, [nostr, queryClient]);

  return null;
}
