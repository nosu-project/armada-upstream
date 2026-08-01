import { createContext } from 'react';
import type { NostrEvent, NostrFilter } from '@nostrify/nostrify';
import type { NostrRumor } from '@/lib/nostrRumor';

/**
 * Where a store operation is scoped.
 *
 * `relay` is the relay a write came FROM, and the relay a read is ASKING ABOUT.
 * It selects the tenant: NIP-29 data lives per-relay because a group id means
 * nothing without its relay, while everything else lives in the shared `main`
 * cache. See `src/lib/db/relayScope.ts` for the rule and why it has to exist.
 *
 * Omitting it on a read means "the global cache" — profiles, git, the user's own
 * lists. Omitting it on a write of relay-relative data means that write is
 * DROPPED, since there is no honest tenant for it.
 */
export interface EventScope {
  signal?: AbortSignal;
  relay?: string;
}

/**
 * The surface the app event store implements — a thin `NStore` shape over
 * ArmadaDB's `main` tenant and the per-relay NIP-29 tenants.
 *
 * Note the asymmetry, which is the point: `event()` takes a signed
 * `NostrEvent`, `query()` returns `NostrRumor`. Signatures go in and do not
 * come out (see src/lib/db/mainEventStore.ts), so anything that needs to
 * re-publish an event verbatim cannot be fed from here — and now says so in the
 * type rather than in a comment nobody has to obey.
 */
export interface ArmadaEventStore {
  event(event: NostrEvent, opts?: EventScope): Promise<void>;
  query(filters: NostrFilter[], opts?: EventScope): Promise<NostrRumor[]>;
  count(filters: NostrFilter[], opts?: EventScope): Promise<{ count: number; approximate?: boolean }>;
  remove(filters: NostrFilter[], opts?: EventScope): Promise<void>;
  close(): Promise<void>;
}

/**
 * The event store is opened asynchronously, so the context carries a
 * `Promise<ArmadaEventStore>` rather than the store itself. Consumers `await`
 * it inside their query functions — the promise resolves once the backing
 * database is open (or to a no-op-degrading store when storage is
 * unavailable).
 */
export type EventStoreContextType = Promise<ArmadaEventStore>;

export const EventStoreContext = createContext<EventStoreContextType | null>(null);
