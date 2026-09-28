import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { KIND_CANVAS } from "@/buzz/kinds";
import { useWireScopes } from "@/wire/useWireScopes";

import type { NostrEvent } from "@nostrify/nostrify";

/**
 * Latest kind-40100 canvas for a Buzz channel. Live via the standing Buzz
 * subscription, invalidating through the `nip29:<channelId>` scope.
 */
export function useBuzzCanvas(relayUrl: string | undefined, channelId: string | undefined) {
  const { nostr } = useNostr();
  const queryClient = useQueryClient();
  const queryKey = ["buzz", "canvas", relayUrl, channelId] as const;

  useWireScopes((scopes) => {
    if (channelId && scopes.has(`nip29:${channelId}`)) {
      void queryClient.invalidateQueries({ queryKey });
    }
  });

  return useQuery<NostrEvent | null>({
    queryKey,
    enabled: Boolean(relayUrl && channelId),
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
      const events = await nostr.relay(relayUrl!).query(
        [{ kinds: [KIND_CANVAS], "#h": [channelId!], limit: 5 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
      );
      if (events.length === 0) return null;
      return events.sort((a, b) => b.created_at - a.created_at)[0];
    },
  });
}
