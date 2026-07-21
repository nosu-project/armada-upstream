import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { KIND_DM_VISIBILITY } from "@/buzz/kinds";
import { useCurrentUser } from "@/hooks/useCurrentUser";

/**
 * The viewer's hidden Buzz DM channels (NIP-DV): the relay maintains a
 * relay-signed, per-viewer kind-30622 snapshot whose `h` tags list the DM
 * channels the viewer has hidden from their sidebar (kind 41012). P-gated:
 * the filter must carry `#p` = the authenticated pubkey.
 */
export function useBuzzHiddenDms(relayUrl: string | undefined): Set<string> {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();

  const query = useQuery<string[]>({
    queryKey: ["buzz", "dm-visibility", relayUrl, user?.pubkey],
    enabled: Boolean(relayUrl && user),
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
      const events = await nostr.relay(relayUrl!).query(
        [{ kinds: [KIND_DM_VISIBILITY], "#p": [user!.pubkey], limit: 1 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
      );
      const newest = events.sort((a, b) => b.created_at - a.created_at)[0];
      if (!newest) return [];
      return newest.tags.filter(([n, v]) => n === "h" && v).map(([, v]) => v);
    },
  });

  return useMemo(() => new Set(query.data ?? []), [query.data]);
}
