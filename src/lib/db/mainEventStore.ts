/**
 * The app-wide event store — the local cache of signed events fetched from
 * relays (profiles, NIP-29 timelines, gift wraps, git activity).
 *
 * One ArmadaDB tenant, `main`. This used to be its own storage stack: a
 * hand-written SQLite schema and NIP-01 filter compiler running on the native
 * Android database (shared with the notification service) or SQLite-WASM over
 * OPFS, with `NIndexedDB` as a degraded fallback. All of it is gone; the store
 * is now an ordinary ArmadaDB tenant like every other subsystem, so there is
 * exactly one database interface in the app and swapping its backing engine is
 * a decision made once, in `armadaDB.ts`, for everything at once.
 *
 * TWO KNOWN REGRESSIONS, accepted deliberately and tracked as follow-ups:
 *
 *  - **Signatures are dropped.** ArmadaDB stores rumors, and these events
 *    arrive signed. Every signature CHECK in the app runs on the relay ingest
 *    path, before the store, so no verification depends on the stored `sig` —
 *    but a consumer that needs to re-publish an event verbatim must get it from
 *    a relay or the publish outbox, never from here.
 *
 *    That rule was stated when this store was written and was already being
 *    broken: the chat timelines merge the store's copy over the signed
 *    optimistic copy of a just-sent message, and "retry failed message"
 *    re-published the result — an empty signature every relay rejects. The
 *    merges now keep the signed copy (`useGroupMessages`, `useBuzzMessages`)
 *    and `useRepublish` refuses an unsigned event outright.
 *  - **The Android notification service's buffer is stranded.** The service
 *    writes into its own SQLite file, which the WebView no longer reads, so
 *    events it received while the app was down are not visible here. Concord V2
 *    is unaffected (its wraps go through the `c2park` tenant), but NIP-29 and
 *    DM traffic buffered by the service is not picked up until the service
 *    hands off through an ArmadaDB-backed path.
 */
import { NKinds } from "@nostrify/nostrify";

import { ARMADA_TENANTS, getArmadaDB } from "./armadaDB";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import type { ArmadaEventStore } from "@/contexts/EventStoreContext";
import type { NostrRumor } from "@/lib/nostrRumor";
import type { NRumorStore } from "./types";

class MainEventStore implements ArmadaEventStore {
  private readonly tenant: NRumorStore;

  constructor() {
    this.tenant = getArmadaDB().tenant(ARMADA_TENANTS.main);
  }

  event(event: NostrEvent, opts?: { signal?: AbortSignal }): Promise<void> {
    // Ephemeral kinds are by definition not storable (NIP-01), and the relay
    // pool hands them to the store like anything else.
    if (NKinds.ephemeral(event.kind)) return Promise.resolve();
    const { sig: _sig, ...rumor } = event;
    return this.tenant.event(rumor, opts);
  }

  query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrRumor[]> {
    return this.tenant.query(filters, opts);
  }

  count(
    filters: NostrFilter[],
    opts?: { signal?: AbortSignal },
  ): Promise<{ count: number; approximate?: boolean }> {
    return this.tenant.count(filters, opts);
  }

  remove(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<void> {
    return this.tenant.remove(filters, opts);
  }

  /**
   * No-op: the connection belongs to the app-wide ArmadaDB instance, which
   * non-React code shares. Closing it here would break the sync loops.
   * `purgeArmadaDB` is what closes and deletes on logout.
   */
  close(): Promise<void> {
    return Promise.resolve();
  }
}

let store: ArmadaEventStore | undefined;

/**
 * The app-wide event store. Resolved lazily but synchronously available — the
 * `Promise` is kept because {@link ArmadaEventStore} consumers await it, and
 * opening the underlying tenant is itself lazy.
 */
export function appEventStore(): Promise<ArmadaEventStore> {
  store ??= new MainEventStore();
  return Promise.resolve(store);
}
