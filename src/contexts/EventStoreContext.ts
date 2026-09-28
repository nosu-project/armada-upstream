import { createContext } from 'react';
import type { NostrEvent, NostrFilter } from '@nostrify/nostrify';
import type { NostrRumor } from '@/lib/nostrRumor';

/**
 * Where a store operation is scoped. `relay` selects the tenant: NIP-29 data is
 * per-relay (see `src/lib/db/relayScope.ts`), everything else in `main`. Omitted
 * on a read = the global cache; omitted on a relay-relative write = DROPPED.
 */
export interface EventScope {
  signal?: AbortSignal;
  relay?: string;
}

/**
 * The app event store: a thin `NStore` over ArmadaDB's `main` and per-relay
 * tenants. `event()` takes signed events but `query()` returns rumors —
 * signatures aren't stored (src/lib/db/mainEventStore.ts).
 */
export interface ArmadaEventStore {
  event(event: NostrEvent, opts?: EventScope): Promise<void>;
  query(filters: NostrFilter[], opts?: EventScope): Promise<NostrRumor[]>;
  count(filters: NostrFilter[], opts?: EventScope): Promise<{ count: number; approximate?: boolean }>;
  remove(filters: NostrFilter[], opts?: EventScope): Promise<void>;
  close(): Promise<void>;
}

/** A `Promise<ArmadaEventStore>` (opened async; degrades to a no-op store without storage). */
export type EventStoreContextType = Promise<ArmadaEventStore>;

export const EventStoreContext = createContext<EventStoreContextType | null>(null);
