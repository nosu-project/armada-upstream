import { createContext } from 'react';
import type { NostrEvent, NostrFilter } from '@nostrify/nostrify';

/**
 * The surface the app event store implements — a thin `NStore` shape over the
 * ArmadaDB `main` tenant. See src/lib/db/mainEventStore.ts, which also
 * documents why reads report an empty `sig`.
 */
export interface ArmadaEventStore {
  event(event: NostrEvent, opts?: { signal?: AbortSignal }): Promise<void>;
  query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrEvent[]>;
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
