import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";

import { isBuzzRelayInfo } from "@/buzz/detect";
import { useEventStore } from "@/hooks/useEventStore";
import { fetchRelayInfoDoc } from "@/hooks/useRelayInfo";
import { useNip29Servers } from "@/hooks/useNip29Servers";
import { buildRelayGroups, KIND_GROUP_METADATA } from "@/lib/nip29";

import type { NostrEvent } from "@nostrify/nostrify";

/**
 * Every visible NIP-29 group as `{ id, relay }`, discovered PER SERVER, since
 * 10009 lists often hold only servers (`r` tags) with no `group` entries —
 * subscribing only to those would leave servers empty. Per relay: cached
 * relay-scoped kind-39000 plus a bounded live directory read. `buzz` marks
 * Buzz relays (wider kind set). Also used by the foreground notifier to map
 * groupId → relay.
 */
export function useWireNip29Groups(): Array<{ id: string; relay: string; buzz?: boolean }> {
  const { nostr } = useNostr();
  const eventStore = useEventStore();

  const servers = useNip29Servers();
  const serversKey = servers.join(",");

  const query = useQuery<Array<{ id: string; relay: string; buzz?: boolean }>>({
    queryKey: ["wire", "nip29-groups", serversKey],
    enabled: servers.length > 0,
    // Quiet periodic refresh for new channels; paused while hidden.
    staleTime: 60_000,
    refetchInterval: 15 * 60_000,
    refetchIntervalInBackground: false,
    queryFn: async ({ signal }) => {
      const store = await eventStore;
      const perRelay = await Promise.all(
        servers.map(async (relay) => {
          // The relay's signing key (kind-39000 author), best effort; the same
          // doc detects Buzz.
          let selfKey: string | undefined;
          let buzz = false;
          try {
            const info = await Promise.race([
              fetchRelayInfoDoc(relay, signal).catch(() => undefined),
              new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 2_000)),
            ]);
            selfKey = info?.self || info?.pubkey;
            buzz = isBuzzRelayInfo(info);
          } catch {
            selfKey = undefined;
          }

          // From THIS relay's tenant, filtered by the relay key so forged
          // metadata can't mint phantom channels; no key → read nothing.
          const cached = selfKey
            ? await store.query([{ kinds: [KIND_GROUP_METADATA], authors: [selfKey], limit: 500 }], {
                relay,
              })
            : [];
          let live: NostrEvent[] = [];
          try {
            live = await nostr.relay(relay).query(
              [{ kinds: [KIND_GROUP_METADATA], ...(selfKey ? { authors: [selfKey] } : {}), limit: 500 }],
              { signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]) },
            );
          } catch {
            // best effort; cached metadata still yields known channels
          }
          return buildRelayGroups([...cached, ...live], relay).map((g) => ({ id: g.id, relay, buzz }));
        }),
      );
      return perRelay.flat();
    },
  });

  return query.data ?? [];
}
