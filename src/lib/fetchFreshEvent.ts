import type { NostrFilter, NPool } from "@nostrify/nostrify";

import type { ArmadaEventStore } from "@/contexts/EventStoreContext";
import type { NostrRumor } from "@/lib/nostrRumor";

interface FetchFreshEventOptions {
  /**
   * Local event store to consult as a fallback floor. When provided, the
   * cached copy is compared against the relay result and the one with the
   * higher `created_at` wins. This guarantees a read-modify-write mutation
   * never goes *backwards* (e.g. a relay miss returning `null` would otherwise
   * cause the caller to rebuild from an empty base and wipe the list).
   *
   * Only pass this for mutations on lists where dropping prior entries is
   * destructive (follow list, mute list, etc.). It does not replace the
   * relay read — the relay is still the primary source of truth.
   */
  store?: ArmadaEventStore;
  /** Abort signal merged with the internal 10s timeout. */
  signal?: AbortSignal;
}

/**
 * Fetches the freshest version of a replaceable/addressable event directly from
 * relays. Ported from Ditto.
 *
 * This MUST be used inside every mutation that performs read-modify-write on a
 * replaceable event (kind 3, 10000-19999, 30000-39999). Reading from TanStack
 * Query cache is unsafe because the cache can be stale — another device or a
 * rapid second mutation can cause data loss when the stale version is republished.
 *
 * By default it bypasses any local cache. Pass `{ store }` to use the local
 * event store as a fallback floor: on a relay miss (or if the relay returns an
 * older copy), the cached event is used so the mutation rebuilds from the last
 * list we actually observed instead of an empty base. The newer of the two (by
 * `created_at`) always wins. That floor is what satisfies the AGENTS.md rule
 * against rebuilding a user-owned list from an empty/failed read.
 *
 * The returned event is a `NostrRumor`: a store hit has had its signature
 * stripped on the way in, so the result is safe to *read* but can never be
 * re-published verbatim. Callers re-sign through `useNostrPublish`.
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

  // Pick the most recent event in case multiple relays return different versions.
  const relayEvent: NostrRumor | null = events.length
    ? events.reduce((latest, current) =>
        current.created_at > latest.created_at ? current : latest,
      )
    : null;

  if (!store) {
    return relayEvent;
  }

  // Fall back to / compare against the locally cached copy so we never publish
  // a list older than the one we already have.
  const [cached] = await store.query([filter]);

  if (!relayEvent) return cached ?? null;
  if (!cached) return relayEvent;
  return cached.created_at > relayEvent.created_at ? cached : relayEvent;
}
