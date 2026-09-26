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
 *  - **iOS** — the same Capacitor plugin, onto Swift (`ios/ArmadaDB`), against
 *    a file in the App Group container so a future notification extension —
 *    a separate process — can open the one the app already wrote.
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

import { perfCount, perfKvWrite, perfMark, perfTime } from "@/lib/perf";

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

/** The platforms that ship a native ArmadaDB implementation. */
const NATIVE_DB_PLATFORMS = new Set(["android", "ios"]);

/**
 * Whether the native store is present.
 *
 * Both checks earn their keep. The platform list is the rule from AGENTS.md —
 * a plugin is gated on the platforms that actually implement it, never on
 * `isNativePlatform()`, which would route a call into a `registerPlugin` proxy
 * with nothing behind it. The plugin check is what makes the rest of the app
 * indifferent to build skew: an iOS build whose plugin failed to register
 * answers `false` and opens IndexedDB, rather than every read rejecting.
 */
export function hasNativeArmadaDB(): boolean {
  return NATIVE_DB_PLATFORMS.has(Capacitor.getPlatform()) &&
    Capacitor.isPluginAvailable("ArmadaDB");
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
  /**
   * A drain is in flight. Only ONE ever is: a write that arrives while a
   * crossing is outstanding joins {@link pending} and is picked up by that
   * drain's next lap, rather than starting a concurrent crossing of its own.
   * That is the whole fix — on a loaded phone a crossing takes real time, and
   * the old per-tick microtask flush spawned one crossing (one hop onto the
   * single plugin thread, one turn of the native lock) per arriving write, so
   * an ingest storm became thousands of serialized lock acquisitions that
   * starved the reads login needed to make progress.
   */
  private draining = false;
  /**
   * Settles once the NEWEST batch — the one still queued in {@link pending},
   * or failing that the one in flight — has crossed. Laps are sequential, so
   * that batch committing implies every earlier one did too, which is exactly
   * what a read needs: every write program-ordered before it. It is NOT "the
   * drain went idle" — under a steady ingest stream the drain never does, and
   * a read that waited for that would sit behind writes queued after it for as
   * long as the stream lasts.
   */
  private tail: Promise<void> = Promise.resolve();
  /** Settles {@link tail} for the batch currently queued; null when none is. */
  private settleQueued: (() => void) | null = null;

  /** Profiler label — the tenant's class, see {@link tenantClass}. */
  private readonly label: string;
  /** Ids already committed, so the relay cache's re-writes cost nothing. */
  private readonly written = new WrittenIds();

  constructor(private readonly id: string, private readonly bridge: ArmadaDBPlugin) {
    this.label = tenantClass(id);
  }

  async query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrRumor[]> {
    // Read-your-writes: commit anything queued before this read was issued, so a
    // caller that fired a write without awaiting it still sees it. The drain
    // spans macrotasks, so unlike the old same-tick microtask flush this cannot
    // be relied on to have already run by the time the read crosses.
    await this.settleWrites(opts?.signal);
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
      // The first write into an empty queue opens a new batch; readers issued
      // from now until it is snapshotted wait on this one.
      if (this.settleQueued === null) {
        this.tail = new Promise<void>((settle) => (this.settleQueued = settle));
      }
      this.scheduleFlush();
    });
  }

  async count(
    filters: NostrFilter[],
    opts?: { signal?: AbortSignal },
  ): Promise<{ count: number; approximate: boolean }> {
    await this.settleWrites(opts?.signal);
    const result = await perfTime(`db.count ${this.label}`, () =>
      this.bridge.count({ tenant: this.id, filters: JSON.stringify(filters) }),
    );
    return { count: result.count, approximate: result.approximate ?? false };
  }

  async remove(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<void> {
    // Commit queued writes first so a remove acts after the writes program-ordered
    // before it, not around them.
    await this.settleWrites(opts?.signal);
    // A removed event has to be storable again, and this class cannot evaluate
    // the filter that removed it.
    this.written.forget();
    await perfTime(`db.remove ${this.label}`, () =>
      this.bridge.remove({ tenant: this.id, filters: JSON.stringify(filters) }),
    );
  }

  private scheduleFlush(): void {
    // A drain already running will pick up whatever is in `pending` on its next
    // lap; starting a second would be the concurrent crossing this exists to
    // avoid.
    if (this.draining) return;
    this.draining = true;
    queueMicrotask(() => void this.drain());
  }

  /**
   * Block until every write queued before this call has crossed — at most the
   * crossing in flight plus the one queued behind it, never the whole stream.
   * Honours `signal` while waiting: a read that has already been given up on
   * must not hold its caller for however long the writes keep coming.
   */
  private settleWrites(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!this.draining) return Promise.resolve();
    if (!signal) return this.tail;
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      void this.tail.then(() => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) reject(signal.reason);
        else resolve();
      });
    });
  }

  /**
   * Drain {@link pending} to the bridge, one crossing per lap, until it is
   * empty. A lap's crossing commits as one transaction; anything that arrives
   * while it is outstanding is waiting in `pending` for the next lap, so a
   * storm of writes folds into a handful of large crossings rather than one
   * crossing each.
   */
  private async drain(): Promise<void> {
    try {
      while (this.pending.length > 0) {
        const writes = this.pending;
        const settle = this.settleQueued;
        this.pending = [];
        this.settleQueued = null;

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
          // A reader waiting on this batch is released either way: the writes
          // it program-ordered behind have been acted on, if only to fail.
          settle?.();
          continue;
        }

        // Settled only after the native commit, so resolving means durable —
        // which is also why the ids are recorded here and not at `event()`.
        for (const write of writes) {
          this.written.add(write.rumor.id);
          write.resolve();
        }
        settle?.();
      }
    } finally {
      // On the normal exit `pending` is empty with no await since the last
      // check, so nothing is stranded between clearing the flag and the next
      // enqueue. Should a lap ever escape the loop with a throw, whatever
      // arrived during its crossing is still queued and would otherwise wait
      // for an unrelated write to start the next drain.
      this.draining = false;
      if (this.pending.length > 0) this.scheduleFlush();
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
/**
 * A stored value that no longer parses is a miss, not a thrown crossing: one
 * corrupt row must not take the rest of its batch down unsettled.
 */
function parseStored(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

class NativeKV implements ArmadaKV {
  private pendingOps: PendingKvOp[] = [];
  /**
   * A drain is in flight; see {@link NativeRumorStore} for the reasoning. Ops
   * that arrive during an outstanding `kvOps` crossing wait in
   * {@link pendingOps} for its next lap instead of each starting a concurrent
   * crossing — the KV half of the same fix, and read-your-writes is preserved
   * either way because gets and lists ride the same ordered queue as the sets.
   */
  private draining = false;

  constructor(private readonly bridge: ArmadaDBPlugin) {}

  private schedule(): void {
    if (this.draining) return;
    this.draining = true;
    queueMicrotask(() => void this.drain());
  }

  /** Drain {@link pendingOps} to the bridge, one crossing per lap, until empty. */
  private async drain(): Promise<void> {
    try {
      while (this.pendingOps.length > 0) {
        const ops = this.pendingOps;
        this.pendingOps = [];
        await this.crossing(ops);
      }
    } finally {
      // As in `NativeRumorStore.drain`: a lap that escapes with a throw must
      // not leave the ops that arrived during it waiting for the next caller.
      this.draining = false;
      if (this.pendingOps.length > 0) this.schedule();
    }
  }

  /** One `kvOps` crossing for a burst, settling each op against its result. */
  private async crossing(ops: PendingKvOp[]): Promise<void> {
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
        op.resolve(typeof value === "string" ? parseStored(value) : undefined);
      } else if (op.op === "list") {
        const entries = Array.isArray(results[i]) ? (results[i] as Array<{ key: string; value: string }>) : [];
        op.resolve(entries.map(({ key, value }) => ({ key, value: parseStored(value) })));
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
    if (import.meta.env.VITE_PROFILE === "1") perfKvWrite(key, value);
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
