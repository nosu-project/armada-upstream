/**
 * The app-wide event store — the local cache of signed events fetched from
 * relays (profiles, git activity, sealed Concord outers), and the router that
 * files relay-relative events under the relay that served them instead.
 *
 * TWO KINDS OF SCOPE, and the split is the whole design (see `relayScope.ts`):
 *
 *  - **`main`** holds what is true whoever served it: a profile, the user's own
 *    group list, git activity, ciphertext addressed to them.
 *  - **`nip29:<relay>`** holds what is only true ON one relay. A NIP-29 group is
 *    named by an `h`/`d` value that means nothing without its relay, and relay
 *    identities can be SHARED between servers, so neither the id nor the signing
 *    key separates two servers' channels. The relay is in the tenant id, so the
 *    separation is structural: a query against one relay's tenant cannot see
 *    another's rows.
 *
 * So `event()` takes the relay it came from, and `query()` takes the relay it is
 * asking about. A relay-relative event with no known relay is DROPPED rather
 * than filed under a guess — `relayScope.ts` explains why that loses nothing.
 *
 * This used to be one tenant and its own storage stack besides: a
 * hand-written SQLite schema and NIP-01 filter compiler running on the native
 * Android database (shared with the notification service) or SQLite-WASM over
 * OPFS, with `NIndexedDB` as a degraded fallback. All of it is gone; the store
 * is now an ordinary ArmadaDB tenant like every other subsystem, so there is
 * exactly one database interface in the app and swapping its backing engine is
 * a decision made once, in `armadaDB.ts`, for everything at once.
 *
 * ONE KNOWN REGRESSION, accepted deliberately:
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
 *
 * The Android notification service used to be a second regression here — it
 * wrote into a private SQLite file the WebView didn't read, so NIP-29 and DM
 * traffic it received while the app was down stayed invisible. That is what the
 * Kotlin port fixed: the service writes through the same tenants this store
 * reads, routing by the same rule (`ServiceStore.kt`), so those events are
 * simply here on open (see `armadaDB.ts`).
 */
import { NKinds } from "@nostrify/nostrify";

import { ARMADA_TENANTS, getArmadaDB } from "./armadaDB";
import { tenantForEvent, nip29Tenant } from "./relayScope";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import type { ArmadaEventStore, EventScope } from "@/contexts/EventStoreContext";
import type { NostrRumor } from "@/lib/nostrRumor";
import type { NRumorStore } from "./types";

class MainEventStore implements ArmadaEventStore {
  /**
   * The tenant handle for an id.
   *
   * Resolved per call rather than memoized here: the adapters already keep one
   * handle per tenant, and a purge REPLACES the whole ArmadaDB instance — so a
   * handle cached at this level would outlive the connection it belongs to and
   * keep reading a database that has been deleted.
   */
  private tenant(id: string): NRumorStore {
    return getArmadaDB().tenant(id);
  }

  /**
   * Where a read is aimed: one relay's NIP-29 tenant when `relay` is given,
   * `main` otherwise. An unusable relay URL resolves to no tenant at all rather
   * than falling back to `main`, so a malformed URL reads empty instead of
   * reading every relay's data at once.
   */
  private scoped(opts?: EventScope): NRumorStore | undefined {
    if (!opts?.relay) return this.tenant(ARMADA_TENANTS.main);
    const id = nip29Tenant(opts.relay);
    return id ? this.tenant(id) : undefined;
  }

  event(event: NostrEvent, opts?: EventScope): Promise<void> {
    // Ephemeral kinds are by definition not storable (NIP-01), and the relay
    // pool hands them to the store like anything else.
    if (NKinds.ephemeral(event.kind)) return Promise.resolve();
    // Relay-relative data with no relay to file it under is dropped, not
    // guessed at: see `relayScope.ts`.
    const id = tenantForEvent(event, opts?.relay, ARMADA_TENANTS.main);
    if (!id) return Promise.resolve();
    const { sig: _sig, ...rumor } = event;
    return this.tenant(id).event(rumor, opts);
  }

  query(filters: NostrFilter[], opts?: EventScope): Promise<NostrRumor[]> {
    return this.scoped(opts)?.query(filters, opts) ?? Promise.resolve([]);
  }

  count(
    filters: NostrFilter[],
    opts?: EventScope,
  ): Promise<{ count: number; approximate?: boolean }> {
    return (
      this.scoped(opts)?.count(filters, opts) ??
      Promise.resolve({ count: 0, approximate: false })
    );
  }

  remove(filters: NostrFilter[], opts?: EventScope): Promise<void> {
    return this.scoped(opts)?.remove(filters, opts) ?? Promise.resolve();
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
