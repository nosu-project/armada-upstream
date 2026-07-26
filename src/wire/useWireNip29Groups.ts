import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";

import { isBuzzRelayInfo } from "@/buzz/detect";
import { useEventStore } from "@/hooks/useEventStore";
import { fetchRelayInfoDoc } from "@/hooks/useRelayInfo";
import { useNip29Servers } from "@/hooks/useNip29Servers";
import { buildRelayGroups, KIND_GROUP_METADATA } from "@/lib/nip29";

import type { NostrEvent } from "@nostrify/nostrify";

/**
 * Every NIP-29 group the user can see, as `{ id, relay }` — discovered PER
 * SERVER, not from the kind-10009 `groups` list.
 *
 * This is the crux of the wire's NIP-29 coverage. A user's 10009 list holds the
 * SERVERS they added (`r` tags) but frequently NO explicit joined-`group`
 * entries — channels are discovered per-relay from the relay-signed kind-39000
 * directory (see useRelayGroups), exactly as the channel list does. If the wire
 * subscribed only to `groupList.groups` it would open ZERO `#h` subscriptions
 * for such servers and their timelines would never ingest (empty servers).
 *
 * So we enumerate the same servers the rail shows (`useNip29Servers`) and, per
 * relay, read the group ids from:
 *   - the relay-PROVENANCE-scoped kind-39000 metadata already in the store
 *     (instant, and the common case after a first visit), and
 *   - a bounded live directory read (relay-key-authored) to pick up channels
 *     not yet cached.
 * The union feeds buildWireSpec's `groups`, so the wire holds one `#h` filter
 * per host covering every channel on it. `buzz` marks channels on a Buzz
 * relay (detected from the same NIP-11 doc), whose wire filter carries the
 * wider Buzz kind set.
 *
 * Shared (same react-query cache entry) by WireSync and the foreground
 * notifier, which uses it to resolve a groupId → relay for channels that
 * aren't in the user's kind-10009 list — e.g. Buzz channels an admin added
 * them to.
 */
export function useWireNip29Groups(): Array<{ id: string; relay: string; buzz?: boolean }> {
  const { nostr } = useNostr();
  const eventStore = useEventStore();

  const servers = useNip29Servers();
  const serversKey = servers.join(",");

  const query = useQuery<Array<{ id: string; relay: string; buzz?: boolean }>>({
    queryKey: ["wire", "nip29-groups", serversKey],
    enabled: servers.length > 0,
    // Relay-signed, rarely-changing directory data. Re-read periodically to
    // pick up newly-created channels; the channel-list UI invalidates on real
    // changes, but the wire keeps its own quiet refresh. Slow, and paused while
    // the tab is hidden.
    staleTime: 60_000,
    refetchInterval: 15 * 60_000,
    refetchIntervalInBackground: false,
    queryFn: async ({ signal }) => {
      const store = await eventStore;
      const perRelay = await Promise.all(
        servers.map(async (relay) => {
          // The relay's own signing key (kind-39000 is authored by it). Best
          // effort — a broken NIP-11 endpoint must not block the others. The
          // same doc also identifies Buzz relays, whose channels get the wider
          // Buzz kind set in the wire filter (see buildWireSpec).
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

          // Cache-first from the store (scoped by the relay's key so channels
          // from same-key relays don't bleed). Then a bounded live read.
          const cached = selfKey
            ? await store.query([{ kinds: [KIND_GROUP_METADATA], authors: [selfKey], limit: 500 }])
            : [];
          let live: NostrEvent[] = [];
          try {
            live = await nostr.relay(relay).query(
              [{ kinds: [KIND_GROUP_METADATA], ...(selfKey ? { authors: [selfKey] } : {}), limit: 500 }],
              { signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]) },
            );
          } catch {
            // Best effort; the cached metadata still yields the known channels.
          }
          return buildRelayGroups([...cached, ...live], relay).map((g) => ({ id: g.id, relay, buzz }));
        }),
      );
      return perRelay.flat();
    },
  });

  return query.data ?? [];
}
