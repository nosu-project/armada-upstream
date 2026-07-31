import { createContext } from 'react';
import type { NostrEvent, NostrFilter } from '@nostrify/nostrify';
import type { NostrRumor } from '@/lib/nostrRumor';

/**
 * The surface the app event store implements — a thin `NStore` shape over the
 * ArmadaDB `main` tenant.
 *
 * Note the asymmetry, which is the point: `event()` takes a signed
 * `NostrEvent`, `query()` returns `NostrRumor`. Signatures go in and do not
 * come out (see src/lib/db/mainEventStore.ts), so anything that needs to
 * re-publish an event verbatim cannot be fed from here — and now says so in the
 * type rather than in a comment nobody has to obey.
 */
export interface ArmadaEventStore {
  event(event: NostrEvent, opts?: { signal?: AbortSignal }): Promise<void>;
  query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrRumor[]>;
  count(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<{ count: number; approximate?: boolean }>;
  remove(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<void>;
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
