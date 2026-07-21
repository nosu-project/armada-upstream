import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useEventStore } from "@/hooks/useEventStore";
import { useRelayInfo } from "@/hooks/useRelayInfo";
import { KIND_RELAY_MEMBERS, parseRelayMemberRoles } from "@/lib/nip29";

import type { NostrEvent } from "@nostrify/nostrify";

/** Newest kind-13534 snapshot wins (it's a replaceable roster). */
function composeRelayMembers(events: NostrEvent[]): Record<string, string> {
  let newest: NostrEvent | undefined;
  for (const event of events) {
    if (!newest || newest.created_at < event.created_at) newest = event;
  }
  return newest ? parseRelayMemberRoles(newest) : {};
}

/**
 * The community-level (NIP-43, kind 13534) membership roster for a relay:
 * `pubkey → owner/admin/member`. A Buzz "community" grants a relay-wide role
 * that its owner/admin hold in *every* channel — distinct from the per-channel
 * NIP-29 admin/member events (39001/39002) that `useGroup` reads.
 *
 * The snapshot carries no `d` scope and is signed by the relay's own key, so we
 * disambiguate a shared IndexedDB cache by the relay's self pubkey: without a
 * known relay author we skip the local read (a 13534 from a *different*
 * community relay would otherwise bleed in) and rely on the background fetch.
 * Relays that don't speak NIP-43 (plain NIP-29, zooid) simply return `{}`.
 */
export function useRelayMembers(relayUrl: string | undefined) {
  const { nostr } = useNostr();
  const eventStore = useEventStore();
  const queryClient = useQueryClient();
  const { data: relayInfo } = useRelayInfo(relayUrl);

  const relaySelf = relayInfo?.self || relayInfo?.pubkey;
  const queryKey = ["nip43", "relay-members", relayUrl, relaySelf];

  return useQuery<Record<string, string>>({
    queryKey,
    queryFn: async ({ signal }) => {
      const store = await eventStore;

      // 1. LOCAL-FIRST: the newest cached snapshot for THIS relay's key.
      const cached = relaySelf
        ? await store.query([{ kinds: [KIND_RELAY_MEMBERS], authors: [relaySelf], limit: 1 }])
        : [];
      const local = composeRelayMembers(cached);

      // 2. BACKGROUND refresh from the host relay (mirrored back into the store).
      void (async () => {
        if (signal.aborted) return;
        try {
          const events = await nostr.relay(relayUrl!).query(
            [{
              kinds: [KIND_RELAY_MEMBERS],
              limit: 1,
              ...(relaySelf ? { authors: [relaySelf] } : {}),
            }],
            { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
          );
          if (signal.aborted || events.length === 0) return;
          queryClient.setQueryData<Record<string, string>>(queryKey, composeRelayMembers(events));
        } catch {
          // Best-effort; the local-first roster already rendered.
        }
      })();

      return local;
    },
    enabled: Boolean(relayUrl),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}
