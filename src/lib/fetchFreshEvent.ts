import type { NostrFilter, NPool } from "@nostrify/nostrify";

import type { ArmadaEventStore } from "@/contexts/EventStoreContext";
import type { NostrRumor } from "@/lib/nostrRumor";

interface FetchFreshEventOptions {
  /**
   * Local store used as a floor: the newer of cached vs relay copy wins, so a
   * relay miss can't make a read-modify-write rebuild from an empty base. Pass
   * only for lists where dropping entries is destructive.
   */
  store?: ArmadaEventStore;
  /** Abort signal merged with the internal 10s timeout. */
  signal?: AbortSignal;
}

/**
 * Fetch the freshest replaceable/addressable event directly from relays (ported
 * from Ditto). MUST be used for every read-modify-write mutation: the query
 * cache can be stale and republishing it loses data. Returns a rumor (store hits
 * are unsigned) — callers re-sign via `useNostrPublish`.
 */
export async function fetchFreshEvent(
  nostr: NPool,
  filter: NostrFilter,
  opts: FetchFreshEventOptions = {},
): Promise<NostrRumor | null> {
  const { store, signal } = opts;

  const timeout = AbortSignal.timeout(10_000);
  const querySignal = signal ? AbortSignal.any([signal, timeout]) : timeout;

  const events = await nostr.query(
    [{ ...filter, limit: 1 }],
    { signal: querySignal },
  );

  const relayEvent: NostrRumor | null = events.length
    ? events.reduce((latest, current) =>
        current.created_at > latest.created_at ? current : latest,
      )
    : null;

  if (!store) {
    return relayEvent;
  }

  const [cached] = await store.query([filter]);

  if (!relayEvent) return cached ?? null;
  if (!cached) return relayEvent;
  return cached.created_at > relayEvent.created_at ? cached : relayEvent;
}
