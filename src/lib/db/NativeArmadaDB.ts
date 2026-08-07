/**
 * The {@link ArmadaDB} adapter for the platforms that keep their data in a
 * SQLite file outside the web layer: a transport onto that store.
 *
 * There is no query engine here. Filters go over a bridge as JSON and rumors
 * come back as JSON; the planning, the tag tokenizing, the NIP-09 pass and the
 * replaceable supersession all happen on the other side.
 *
 * Two bridges implement the same surface, and the difference between them ends
 * at the transport:
 *
 *  - **Android** (default) — the Capacitor plugin, onto Kotlin
 *    (`buzz.armada.app.db.SqliteArmadaDb`), against the same SQLite file the
 *    background notification service writes into.
 *  - **Desktop** — Electron IPC, onto `SqliteArmadaDB` running on
 *    `node:sqlite` in the shell's main process (see `ElectronArmadaDB.ts` and
 *    `electronMain.ts`).
 *
 * Sharing this class rather than writing a second adapter is deliberate: the
 * batching and ordering below are the expensive part to get right, and a
 * per-platform copy is a per-platform chance to get it wrong.
 *
 * On Android, sharing the FILE with the notification service is the point. The
 * service used to keep a private database with its own schema, and the only way
 * an event it received reached the app was a cursor drain that replayed it into
 * a second store — so a message could be notified, be durable, and still not be
 * *in the app* until the WebView had caught up. Now the service writes the rumor
 * where the app reads it, and the drain is left doing only the part that was
 * ever really routing.
 *
 * Everything crosses as JSON text rather than as structured arguments:
 * Capacitor's marshalling would have to guess between an integer `kind` and a
 * float, and a page of rumors is far cheaper as one string this side parses than
 * as a few thousand marshalled objects. Electron's IPC would carry the integer
 * faithfully, but keeps the text format anyway — the size argument holds there
 * too, and one wire format is what lets both platforms share this adapter.
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
import type {
  ArmadaDB,
  ArmadaKV,
  ArmadaKVEntry,
  ArmadaKVListOptions,
  ArmadaKVSelector,
  NRumorStore,
} from "./types";

import { resolveKvRange, tenantClass } from "./types";
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
  /**
   * The entries a selector picks out, as a JSON array string of
   * `{ key, value }` — `value` being the stored JSON TEXT, not the parsed value.
   * Re-serializing it natively would risk changing a number's spelling; this
   * side is the only one that parses.
   */
  kvList(
    options: { prefix?: string; start?: string; end?: string; limit?: number; reverse?: boolean },
  ): Promise<{ entries: string }>;
  /**
   * A whole burst of KV operations as ONE crossing: `ops` is a JSON array of
   * `{ op: "get" | "set" | "delete" | "list", ... }`, executed in arrival
   * order inside one native transaction. `results` is a JSON array aligned
   * with `ops`: the stored JSON text (or null) for a get, null for a
   * set/delete, an array of `{ key, value }` for a list.
   */
  kvOps(options: { ops: string }): Promise<{ results: string }>;
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
  private readonly bridge: ArmadaDBPlugin;
  readonly kv: ArmadaKV;

  /**
   * @param bridge The transport to the native store. Defaults to the Capacitor
   * plugin (Android); the Electron desktop shell passes its own IPC bridge
   * onto the main process, which runs the same SQLite store over `node:sqlite`
   * (see `ElectronArmadaDB.ts`). Everything below the transport — the write
   * coalescing, the KV op batching, the ordering guarantees — is identical on
   * both, which is the reason this takes a parameter rather than the two
   * platforms each growing an adapter.
   */
  constructor(bridge?: ArmadaDBPlugin) {
    this.bridge = bridge ?? ArmadaDBBridge();
    this.kv = new NativeKV(this.bridge);
  }

  tenant(id: string): NRumorStore {
    let store = this.stores.get(id);
    if (!store) {
      perfMark("db.tenant open", id);
      store = new NativeRumorStore(id, this.bridge);
      this.stores.set(id, store);
    }
    return store;
  }

  /** Every tenant the native store has ever been written to. */
  async tenantIds(): Promise<string[]> {
    const { tenants } = await this.bridge.tenants();
    return JSON.parse(tenants) as string[];
  }

  /** Empty every table. Unlike the IndexedDB purge this keeps the connection. */
  async wipe(): Promise<void> {
    await this.bridge.wipe();
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

  constructor(private readonly id: string, private readonly bridge: ArmadaDBPlugin) {
    this.label = tenantClass(id);
  }

  async query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrRumor[]> {
    opts?.signal?.throwIfAborted();
    // Every bridge call is a hop onto Capacitor's single plugin thread and then
    // a lock held for the whole native method, so these serialize against each
    // other AND against the notification service. The call count matters as much
    // as the total.
    const { rumors } = await perfTime(`db.query ${this.label}`, () =>
      this.bridge.query({ tenant: this.id, filters: JSON.stringify(filters) }),
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
      this.bridge.count({ tenant: this.id, filters: JSON.stringify(filters) }),
    );
    return { count: result.count, approximate: result.approximate ?? false };
  }

  async remove(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<void> {
    opts?.signal?.throwIfAborted();
    // A removed event has to be storable again, and this class cannot evaluate
    // the filter that removed it.
    this.written.forget();
    await perfTime(`db.remove ${this.label}`, () =>
      this.bridge.remove({ tenant: this.id, filters: JSON.stringify(filters) }),
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
          this.bridge.event({
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

/** One queued KV operation, as it will cross the bridge (minus the settlers). */
type PendingKvOp =
  | { op: "get"; key: string; resolve: (value: unknown) => void }
  | { op: "set"; key: string; value: string; resolve: () => void; reject: (error: unknown) => void }
  | { op: "delete"; key: string; resolve: () => void; reject: (error: unknown) => void }
  | {
    op: "list";
    prefix?: string;
    start?: string;
    end?: string;
    limit?: number;
    reverse?: boolean;
    resolve: (entries: ArmadaKVEntry<unknown>[]) => void;
  };

/**
 * The KV, carried as JSON text. Serializing on this side is what keeps the
 * native store from having to agree with JavaScript about how a value
 * round-trips — the contract already says only JSON-serializable values are
 * supported.
 *
 * Operations are coalesced on a microtask and cross the bridge as ONE `kvOps`
 * call, mirroring `NativeRumorStore`'s write batching and the IndexedDB
 * adapter's op queue: every bridge call is a hop onto Capacitor's single
 * plugin thread and a turn of the native store's global lock (shared with the
 * notification service), so a burst of per-op calls paid that toll per key —
 * and Capacitor does not promise call ORDER across its thread pool, so a
 * `list()` racing a fire-and-forget `set()` could historically pass it.
 * Executing the burst in arrival order inside one native transaction keeps
 * read-your-writes exactly as the web adapter defines it.
 */
class NativeKV implements ArmadaKV {
  private pendingOps: PendingKvOp[] = [];
  private flushScheduled = false;

  constructor(private readonly bridge: ArmadaDBPlugin) {}

  private schedule(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      void this.flush();
    });
  }

  private async flush(): Promise<void> {
    const ops = this.pendingOps;
    this.pendingOps = [];
    if (ops.length === 0) return;

    let results: Array<string | null | Array<{ key: string; value: string }>>;
    try {
      const wire = ops.map((op) => {
        if (op.op === "get" || op.op === "delete") return { op: op.op, key: op.key };
        if (op.op === "set") return { op: op.op, key: op.key, value: op.value };
        const { resolve: _resolve, ...listOp } = op;
        return listOp;
      });
      const response = await perfTime(
        "kv.ops",
        () => this.bridge.kvOps({ ops: JSON.stringify(wire) }),
        () => ops.length,
        "ops",
      );
      results = JSON.parse(response.results) as typeof results;
    } catch (error) {
      // Match the per-op contracts from the unbatched days (and the web
      // adapter): a failed read is a miss, a failed write rejects.
      for (const op of ops) {
        if (op.op === "get") op.resolve(undefined);
        else if (op.op === "list") op.resolve([]);
        else op.reject(error);
      }
      return;
    }

    for (const [i, op] of ops.entries()) {
      if (op.op === "get") {
        const value = results[i];
        op.resolve(typeof value === "string" ? (JSON.parse(value) as unknown) : undefined);
      } else if (op.op === "list") {
        const entries = Array.isArray(results[i]) ? (results[i] as Array<{ key: string; value: string }>) : [];
        op.resolve(entries.map(({ key, value }) => ({ key, value: JSON.parse(value) as unknown })));
      } else {
        op.resolve();
      }
    }
  }

  get<T>(key: string): Promise<T | undefined> {
    return perfTime("kv.get", () =>
      new Promise<T | undefined>((resolve) => {
        this.pendingOps.push({ op: "get", key, resolve: resolve as (value: unknown) => void });
        this.schedule();
      }));
  }

  set<T>(key: string, value: T): Promise<void> {
    return perfTime("kv.set", () =>
      new Promise<void>((resolve, reject) => {
        // `undefined` (and anything else without a JSON form) is out of
        // contract; normalized to null so the adapters agree instead of
        // throwing here.
        this.pendingOps.push({ op: "set", key, value: JSON.stringify(value) ?? "null", resolve, reject });
        this.schedule();
      }));
  }

  delete(key: string): Promise<void> {
    return perfTime("kv.delete", () =>
      new Promise<void>((resolve, reject) => {
        this.pendingOps.push({ op: "delete", key, resolve, reject });
        this.schedule();
      }));
  }

  async list<T>(
    selector: ArmadaKVSelector = {},
    opts: ArmadaKVListOptions = {},
  ): Promise<ArmadaKVEntry<T>[]> {
    // Resolved native-side, like the rest of the planning: Kotlin's `KvRange`
    // is the port of `resolveKvRange`, and the crossing carries the selector
    // rather than the bounds derived from it. Resolved here too, and only for
    // its refusals — an invalid selector is a caller's bug, and it should be the
    // same TypeError on every platform rather than a rejected bridge call.
    if (resolveKvRange(selector).empty) return [];

    return perfTime(
      "kv.list",
      () =>
        new Promise<ArmadaKVEntry<T>[]>((resolve) => {
          this.pendingOps.push({
            op: "list",
            ...selector,
            ...opts,
            resolve: resolve as (entries: ArmadaKVEntry<unknown>[]) => void,
          });
          this.schedule();
        }),
      (entries) => entries.length,
      "entries",
    );
  }
}
