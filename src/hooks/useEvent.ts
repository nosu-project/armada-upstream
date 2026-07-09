import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";

import { useEventStore } from "@/hooks/useEventStore";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";

/**
 * Extract write relay URLs from a NIP-65 (kind 10002) relay list event.
 * Tags with no marker are both read+write; tags with "write" are write-only.
 */
function extractWriteRelays(event: NostrEvent): string[] {
  const relays = new Set<string>();
  for (const [name, url, marker] of event.tags) {
    if (name !== "r" || marker === "read" || !url) continue;
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "wss:") {
        relays.add(parsed.href);
      }
    } catch {
      // skip malformed URLs
    }
  }
  return [...relays];
}

/**
 * Fetches a single Nostr event by its hex ID. Resolution order:
 * 1. Local IndexedDB cache (events are immutable, so a hit is authoritative)
 * 2. The configured relay pool
 * 3. Relay hints from the nevent identifier
 * 4. The author's NIP-65 write relays (when an author hint is available)
 */
export function useEvent(eventId: string | undefined, relays?: string[], authorHint?: string) {
  const { nostr } = useNostr();
  const eventStore = useEventStore();

  return useQuery<NostrEvent | null>({
    queryKey: ["event", eventId ?? "", relays ?? [], authorHint ?? ""],
    queryFn: async () => {
      if (!eventId) return null;
      const filter: NostrFilter[] = [{ ids: [eventId], limit: 1 }];

      const store = await eventStore;
      const [cached] = await store.query(filter);
      if (cached) return cached;

      const events = await nostr.query(filter, { signal: AbortSignal.timeout(5000) });
      if (events.length > 0) return events[0];

      if (relays && relays.length > 0) {
        try {
          const hintEvents = await nostr.group(relays).query(filter, { signal: AbortSignal.timeout(5000) });
          if (hintEvents.length > 0) {
            void store.event(hintEvents[0]);
            return hintEvents[0];
          }
        } catch {
          // relay hint query failed — fall through
        }
      }

      // Last resort: the author's NIP-65 write relays
      if (authorHint) {
        try {
          const [relayList] = await nostr.query(
            [{ kinds: [10002], authors: [authorHint], limit: 1 }],
            { signal: AbortSignal.timeout(5000) },
          );
          const writeRelays = relayList ? extractWriteRelays(relayList).slice(0, 5) : [];
          if (writeRelays.length > 0) {
            const found = await nostr.group(writeRelays).query(filter, { signal: AbortSignal.timeout(6000) });
            if (found.length > 0) {
              void store.event(found[0]);
              return found[0];
            }
          }
        } catch {
          // give up
        }
      }

      return null;
    },
    enabled: !!eventId,
    staleTime: 5 * 60 * 1000,
  });
}

/** Coordinates for an addressable event (naddr). */
export interface AddrCoords {
  kind: number;
  pubkey: string;
  identifier: string;
}

/** Whether a kind is addressable (30000-39999) and thus identified by its d-tag. */
function isAddressableKind(kind: number): boolean {
  return kind >= 30000 && kind < 40000;
}

/** Fetches a single addressable Nostr event by kind + pubkey + d-tag. */
export function useAddrEvent(addr: AddrCoords | undefined, relays?: string[]) {
  const { nostr } = useNostr();
  const eventStore = useEventStore();

  return useQuery<NostrEvent | null>({
    queryKey: ["addr-event", addr?.kind ?? 0, addr?.pubkey ?? "", addr?.identifier ?? ""],
    queryFn: async () => {
      if (!addr) return null;
      const baseFilter: NostrFilter = { kinds: [addr.kind], authors: [addr.pubkey], limit: 1 };
      if (isAddressableKind(addr.kind)) {
        baseFilter["#d"] = [addr.identifier];
      }
      const filter: NostrFilter[] = [baseFilter];

      const events = await nostr.query(filter, { signal: AbortSignal.timeout(5000) });
      if (events.length > 0) return events[0];

      if (relays && relays.length > 0) {
        try {
          const hintEvents = await nostr.group(relays).query(filter, { signal: AbortSignal.timeout(5000) });
          if (hintEvents.length > 0) return hintEvents[0];
        } catch {
          // fall through
        }
      }

      // Fall back to the locally cached copy.
      const store = await eventStore;
      const cacheFilter: NostrFilter = { kinds: [addr.kind], authors: [addr.pubkey] };
      if (isAddressableKind(addr.kind)) {
        cacheFilter["#d"] = [addr.identifier];
      }
      const [cached] = await store.query([cacheFilter]);
      return cached ?? null;
    },
    enabled: !!addr,
    staleTime: 5 * 60 * 1000,
  });
}
