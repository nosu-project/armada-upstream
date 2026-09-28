import { useNostr } from "@nostrify/react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { onColdLaunchResolved, peekColdLaunchDeepLink } from "@/lib/coldLaunchDeepLink";
import { routeParamToRelay } from "@/lib/platform";

import type { NostrEvent } from "@nostrify/nostrify";

/** Mirrors useGroupMessages. */
const TIMELINE_KINDS = [9, 1068];
/** Mirrors useGroupMessages' PAGE_SIZE. */
const PAGE_SIZE = 30;

function sortDedupe(events: NostrEvent[]): NostrEvent[] {
  const byId = new Map<string, NostrEvent>();
  for (const e of events) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => a.created_at - b.created_at);
}

/**
 * Cold-launch warmup for a notification deep link (native only). Opens the
 * room's relay and fetches its newest page while React is still mounting, and
 * merges it into the room's query cache. Warm navigations don't need this.
 */
export function DeepLinkWarmup() {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();

  useEffect(() => {
    return onColdLaunchResolved(() => {
      const path = peekColdLaunchDeepLink();
      if (!path) return;
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
        } catch { /* ignore */ }
      })();
    });
  }, [nostr, queryClient]);

  return null;
}
