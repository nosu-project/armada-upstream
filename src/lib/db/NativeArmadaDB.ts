/**
 * The {@link ArmadaDB} adapter for Android: a transport onto the native store.
 *
 * There is no query engine here. Filters go over the Capacitor bridge as JSON
 * and rumors come back as JSON; the planning, the tag tokenizing, the NIP-09
 * pass and the replaceable supersession all happen in Kotlin
 * (`buzz.armada.app.db.SqliteArmadaDb`), against the same SQLite file the
 * background notification service writes into.
 *
 * That sharing is the point. The service used to keep a private database with
 * its own schema, and the only way an event it received reached the app was a
 * cursor drain that replayed it into a second store — so a message could be
 * notified, be durable, and still not be *in the app* until the WebView had
 * caught up. Now the service writes the rumor where the app reads it, and the
 * drain is left doing only the part that was ever really routing.
 *
 * Everything crosses as JSON text rather than as structured plugin arguments:
 * Capacitor's marshalling would have to guess between an integer `kind` and a
 * float, and a page of rumors is far cheaper as one string this side parses than
 * as a few thousand marshalled objects.
 *
 * Writes are coalesced per tenant on a microtask, mirroring the SQLite store's
 * own batching: every `event()` call made before the caller next awaits crosses
 * the bridge once and commits as one transaction. Without that a backfill would
 * pay a bridge round trip and a transaction per rumor.
 */
import { Capacitor, registerPlugin } from "@capacitor/core";

import { perfCount, perfMark, perfTime } from "@/lib/perf";

import type { NostrFilter } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";
import type { ArmadaDB, ArmadaKV, NRumorStore } from "./types";

import { tenantClass } from "./types";
import { WrittenIds } from "./writtenIds";

/** The native surface, as `ArmadaDbPlugin.kt` exposes it. */
export interface ArmadaDBPlugin {
  /** Rumors matching any filter, newest-first, as a JSON array string. */
  query(options: { tenant: string; filters: string }): Promise<{ rumors: string }>;
  /** Store a JSON array of rumors in one transaction. */
  event(options: { tenant: string; rumors: string }): Promise<void>;
  count(options: { tenant: string; filters: string }): Promise<{ count: number; approximate: boolean }>;
  remove(options: { tenant: string; filters: string }): Promise<void>;
  /** Every tenant ever written to, as a JSON array string. */
  tenants(): Promise<{ tenants: string }>;
  /** The stored JSON text for a key; `value` is absent when unset. */
  kvGet(options: { key: string }): Promise<{ value?: string }>;
  kvSet(options: { key: string; value: string }): Promise<void>;
  kvDelete(options: { key: string }): Promise<void>;
  kvKeys(options: { prefix?: string }): Promise<{ keys: string }>;
  /** Empty every table (logout purge). The file and its schema survive. */
  wipe(): Promise<void>;
}

let bridge: ArmadaDBPlugin | undefined;

/**
 * The plugin handle, registered on first use rather than at import.
 *
 * Registering is a global side effect that throws on a second call for the same
 * name, so doing it at import would make this module unimportable twice — which
 * any test that resets its module graph does.
 */
function ArmadaDBBridge(): ArmadaDBPlugin {
  return (bridge ??= registerPlugin<ArmadaDBPlugin>("ArmadaDB"));
}

/**
 * Whether the native store is present. Android-only: the plugin is registered
 * in `MainActivity`, and iOS has no implementation, so the check has to be for
 * the plugin rather than for "native".
 */
export function hasNativeArmadaDB(): boolean {
  return Capacitor.getPlatform() === "android" && Capacitor.isPluginAvailable("ArmadaDB");
}

export class NativeArmadaDB implements ArmadaDB {
  private readonly stores = new Map<string, NativeRumorStore>();
  readonly kv: ArmadaKV = new NativeKV();

  tenant(id: string): NRumorStore {
    let store = this.stores.get(id);
    if (!store) {
      perfMark("db.tenant open", id);
      store = new NativeRumorStore(id);
      this.stores.set(id, store);
    }
    return store;
  }

  /** Every tenant the native store has ever been written to. */
  async tenantIds(): Promise<string[]> {
    const { tenants } = await ArmadaDBBridge().tenants();
    return JSON.parse(tenants) as string[];
  }

  /** Empty every table. Unlike the IndexedDB purge this keeps the connection. */
  async wipe(): Promise<void> {
    await ArmadaDBBridge().wipe();
  }

  /** Nothing to close: the native store owns the connection, for the service too. */
  close(): Promise<void> {
    return Promise.resolve();
  }

  [Symbol.toStringTag] = "NativeArmadaDB";
}

/** A rumor queued for the next batched write, with its caller's settlers. */
interface PendingWrite {
  rumor: NostrRumor;
  resolve(): void;
  reject(error: unknown): void;
}

class NativeRumorStore implements NRumorStore {
  private pending: PendingWrite[] = [];
  private flushScheduled = false;

  /** Profiler label — the tenant's class, see {@link tenantClass}. */
  private readonly label: string;
  /** Ids already committed, so the relay cache's re-writes cost nothing. */
  private readonly written = new WrittenIds();

  constructor(private readonly id: string) {
    this.label = tenantClass(id);
  }

  async query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrRumor[]> {
    opts?.signal?.throwIfAborted();
    // Every bridge call is a hop onto Capacitor's single plugin thread and then
    // a lock held for the whole native method, so these serialize against each
    // other AND against the notification service. The call count matters as much
    // as the total.
    const { rumors } = await perfTime(`db.query ${this.label}`, () =>
      ArmadaDBBridge().query({ tenant: this.id, filters: JSON.stringify(filters) }),
    );
    opts?.signal?.throwIfAborted();
    return perfTime(
      `db.parse ${this.label}`,
      async () => JSON.parse(rumors) as NostrRumor[],
      (rows) => rows.length,
    );
  }

  event(event: NostrRumor): Promise<void> {
    // See `writtenIds.ts`: an id is a hash of the event, so a re-write stores
    // nothing new. Worth more here than on the web — a skipped write is also a
    // JSON payload not serialized, a hop off the single Capacitor plugin thread
    // not taken, and a turn of the native store's global lock not waited for.
    if (this.written.has(event.id)) {
      perfCount(`db.write ${this.label} (skipped)`, 0, 1, "events");
      return Promise.resolve();
    }
    // The native store drops a `sig` itself, but stripping here keeps the
    // request small on a bridge that serializes everything it carries.
    const { sig: _sig, ...rumor } = event as NostrRumor & { sig?: string };

    return new Promise<void>((resolve, reject) => {
      this.pending.push({ rumor, resolve, reject });
      this.scheduleFlush();
    });
  }

  async count(
    filters: NostrFilter[],
    opts?: { signal?: AbortSignal },
  ): Promise<{ count: number; approximate: boolean }> {
    opts?.signal?.throwIfAborted();
    const result = await perfTime(`db.count ${this.label}`, () =>
      ArmadaDBBridge().count({ tenant: this.id, filters: JSON.stringify(filters) }),
    );
    return { count: result.count, approximate: result.approximate ?? false };
  }

  async remove(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<void> {
    opts?.signal?.throwIfAborted();
    // A removed event has to be storable again, and this class cannot evaluate
    // the filter that removed it.
    this.written.forget();
    await perfTime(`db.remove ${this.label}`, () =>
      ArmadaDBBridge().remove({ tenant: this.id, filters: JSON.stringify(filters) }),
    );
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;

    queueMicrotask(() => {
      this.flushScheduled = false;
      void this.flush();
    });
  }

  /** Cross the bridge once for the whole burst; it commits as one transaction. */
  private async flush(): Promise<void> {
    const writes = this.pending;
    if (writes.length === 0) return;
    this.pending = [];

    try {
      await perfTime(
        `db.write ${this.label}`,
        () =>
          ArmadaDBBridge().event({
            tenant: this.id,
            rumors: JSON.stringify(writes.map((write) => write.rumor)),
          }),
        () => writes.length,
      );
    } catch (error) {
      for (const write of writes) write.reject(error);
      return;
    }

    // Settled only after the native commit, so resolving means durable — which
    // is also why the ids are recorded here and not at `event()`.
    for (const write of writes) {
      this.written.add(write.rumor.id);
      write.resolve();
    }
  }

  [Symbol.toStringTag] = "NativeRumorStore";
}

/**
 * The KV, carried as JSON text. Serializing on this side is what keeps the
 * native store from having to agree with JavaScript about how a value
 * round-trips — the contract already says only JSON-serializable values are
 * supported.
 */
class NativeKV implements ArmadaKV {
  async get<T>(key: string): Promise<T | undefined> {
    const { value } = await perfTime("kv.get", () => ArmadaDBBridge().kvGet({ key }));
    if (typeof value !== "string") return undefined;
    return JSON.parse(value) as T;
  }

  async set<T>(key: string, value: T): Promise<void> {
    // `undefined` (and anything else without a JSON form) is out of contract;
    // normalized to null so the adapters agree instead of throwing here.
    await perfTime("kv.set", () =>
      ArmadaDBBridge().kvSet({ key, value: JSON.stringify(value) ?? "null" }),
    );
  }

  async delete(key: string): Promise<void> {
    await perfTime("kv.delete", () => ArmadaDBBridge().kvDelete({ key }));
  }

  async keys(prefix?: string): Promise<string[]> {
    const { keys } = await perfTime("kv.keys", () => ArmadaDBBridge().kvKeys({ prefix }));
    return JSON.parse(keys) as string[];
  }
}
