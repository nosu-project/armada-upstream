import { useNostr } from "@nostrify/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useEventStore } from "@/hooks/useEventStore";
import { useRelayInfo } from "@/hooks/useRelayInfo";
import { KIND_RELAY_MEMBERS, parseRelayMemberRoles } from "@/lib/nip29";

import type { NostrRumor } from "@/lib/nostrRumor";

/** Newest kind-13534 snapshot wins (replaceable roster). */
function composeRelayMembers(events: NostrRumor[]): Record<string, string> {
  let newest: NostrRumor | undefined;
  for (const event of events) {
    if (!newest || newest.created_at < event.created_at) newest = event;
  }
  return newest ? parseRelayMemberRoles(newest) : {};
}

/**
 * NIP-43 (kind 13534) relay-wide roster (`pubkey → owner/admin/member`), distinct from NIP-29
 * 39001/39002. Relays without NIP-43 return `{}`.
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

      // The relay tenant isolates servers sharing a key; the author filter stops a rogue 13534 from
      // winning `limit: 1`.
      const cached = relaySelf
        ? await store.query([{ kinds: [KIND_RELAY_MEMBERS], authors: [relaySelf], limit: 1 }], {
            relay: relayUrl,
          })
        : [];
      const local = composeRelayMembers(cached);

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
