import { createContext } from 'react';
import type { NostrEvent, NostrFilter } from '@nostrify/nostrify';

/**
 * The surface every app event store implements. Backed by the shared SQLite
 * database (native on Android — the same file the notification service
 * writes — and SQLite-WASM over OPFS on web/Electron), with NIndexedDB as
 * the degraded-environment fallback. See src/lib/sqlite/eventStore.ts.
 */
export interface ArmadaEventStore {
  event(event: NostrEvent, opts?: { signal?: AbortSignal }): Promise<void>;
  query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrEvent[]>;
  count(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<{ count: number; approximate?: boolean }>;
  remove(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<void>;
  close(): Promise<void>;
  /** Optional fast wipe (logout purge) — drops every row, keeps the schema. */
  wipe?(): Promise<void>;
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
