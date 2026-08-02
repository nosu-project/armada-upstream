/**
 * The IndexedDB adapter for {@link ArmadaDB} — the web/Electron backend.
 *
 * Each tenant is its own IndexedDB database wrapping Nostrify's `NIndexedDB`
 * (a strfry-derived query planner: id / tag / pubkey+kind index cascade,
 * batched writes, replaceable supersession, NIP-09 on write). Rumors are
 * stored as events with an empty `sig`, which is stripped again on read —
 * the field is never exposed and never trusted.
 *
 * One database per tenant, rather than one shared database with a tenant
 * column, because IndexedDB has no cheap way to prefix every index: scoping
 * would mean rebuilding the planner around composite keys. Separate databases
 * get isolation for free, and a tenant can be dropped with a single
 * `deleteDatabase`.
 */
import { NIndexedDB } from "@nostrify/indexeddb";
import { openDB } from "idb";

import { perfCount, perfMark, perfTime } from "@/lib/perf";

import { defaultIndexTags, prefixUpperBound, tenantClass } from "./types";
import { WrittenIds } from "./writtenIds";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import type { DBSchema, IDBPDatabase } from "idb";
import type { NostrRumor } from "@/lib/nostrRumor";
import type { ArmadaDB, ArmadaDBOpts, ArmadaKV, NRumorStore } from "./types";

/** Strip the placeholder signature `NIndexedDB` round-trips. */
function toRumor(event: NostrEvent): NostrRumor {
  const { sig: _sig, ...rumor } = event;
  return rumor;
}

/** Present a rumor as an event for `NIndexedDB`, which types `sig` required. */
function toEvent(rumor: NostrRumor): NostrEvent {
  return { ...rumor, sig: "" };
}

/**
 * A compact, LOW-CARDINALITY description of what a read asked for, for the
 * profiler.
 *
 * "533 reads of `main` returned 1072 rows" says the reads are tiny and
 * repetitive, but not who is issuing them or whether they could have been one
 * read. The kinds plus which fields were present is enough to recognise the
 * caller (`k0` is a profile lookup, `k9+#channel` a channel timeline) without
 * minting a bucket per pubkey — so ids, authors and tag VALUES are counted, never
 * spelled.
 */
function filterShape(filters: NostrFilter[]): string {
  const parts = filters.map((f) => {
    const bits: string[] = [];
    if (f.kinds?.length) bits.push(`k${[...f.kinds].sort((a, b) => a - b).join(",")}`);
    if (f.ids?.length) bits.push(`ids×${f.ids.length}`);
    if (f.authors?.length) bits.push(`authors×${f.authors.length}`);
    for (const key of Object.keys(f)) if (key.startsWith("#")) bits.push(key);
    if (f.search) bits.push("search");
    if (f.since !== undefined || f.until !== undefined) bits.push("time");
    bits.push(f.limit === undefined ? "NO-LIMIT" : `limit${f.limit}`);
    return bits.join("+");
  });
  // One bucket per distinct shape, and a multi-filter read reports as one.
  const unique = [...new Set(parts)].sort();
  return unique.length > 3 ? `${unique.slice(0, 3).join(" | ")} | +${unique.length - 3} more` : unique.join(" | ");
}

class IndexedDBRumorStore implements NRumorStore {
  private readonly store: NIndexedDB;
  /** Profiler label — the tenant's class, see {@link tenantClass}. */
  private readonly label: string;
  private readonly indexTags: (rumor: NostrRumor) => string[][];
  /**
   * Whether this store's connection is known open.
   *
   * `NIndexedDB` is constructed synchronously and every method awaits the open
   * internally, so a call issued before the connection settles reports the
   * OPEN's cost, not the operation's. Charging both to one label makes a fast
   * store with a slow open indistinguishable from a uniformly slow one — and
   * since a boot opens a database per tenant, that difference is the whole
   * question. The first operation per store is labelled apart; `opened` flips
   * once one has resolved.
   */
  private opened = false;
  /** Ids already committed, so the relay cache's re-writes cost nothing. */
  private readonly written = new WrittenIds();

  constructor(name: string, indexTags: (rumor: NostrRumor) => string[][], label: string) {
    this.store = new NIndexedDB(name, { indexTags: (event) => indexTags(event) });
    this.label = label;
    this.indexTags = indexTags;
  }

  /** `db.<op> <class>` once the connection is up, `db.<op> <class> (cold)` before. */
  private op(name: string): string {
    return this.opened ? `db.${name} ${this.label}` : `db.${name} ${this.label} (cold)`;
  }

  private async settled<T>(promise: Promise<T>): Promise<T> {
    try {
      return await promise;
    } finally {
      this.opened = true;
    }
  }

  async query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrRumor[]> {
    // Rows RETURNED, not rows walked — the planner walks more than it yields
    // (an under-filled `limit` walks its whole index range), so a high mean with
    // a low row count is the signature of a scan and worth reading as one.
    const events = await perfTime(
      this.op("query"),
      () => this.settled(this.store.query(filters, opts)),
      (rows) => rows.length,
    );
    // Same elapsed time, bucketed by what was asked instead of by tenant — so a
    // total can be attributed to a caller rather than only to a store.
    perfCount(`shape ${this.label} ${filterShape(filters)}`, 0, events.length);
    return events.map(toRumor);
  }

  /**
   * Writes queued for the on-disk existence check, keyed by id. Duplicate
   * `event()` calls for one id inside a window collapse onto one entry.
   */
  private gate = new Map<
    string,
    {
      rumor: NostrRumor;
      opts?: { signal?: AbortSignal };
      settlers: Array<{ resolve: () => void; reject: (error: unknown) => void }>;
    }
  >();
  /** Whether a gate flush is already scheduled for the current burst. */
  private gateScheduled = false;

  event(event: NostrRumor, opts?: { signal?: AbortSignal }): Promise<void> {
    // An id is a hash of the event, so a re-write can store nothing new. Two
    // dedupe layers, cheapest first: `written` remembers what THIS session
    // committed (or proved on disk), free but empty at boot — and the gate
    // below asks the database itself about everything else, which is what
    // stops a warm boot from re-writing its whole downloaded corpus. Measured
    // before the gate existed: 1587 writes into `main` on one warm boot with
    // sweeps reporting "0 new", each write a share of a readwrite transaction
    // that starved the boot's reads (a profile lookup averaged 21.9s).
    if (this.written.has(event.id)) {
      perfCount(`db.write ${this.label} (skipped)`, 0, 1, "events");
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const pending = this.gate.get(event.id);
      if (pending) {
        pending.settlers.push({ resolve, reject });
        return;
      }
      this.gate.set(event.id, { rumor: event, opts, settlers: [{ resolve, reject }] });
      if (!this.gateScheduled) {
        this.gateScheduled = true;
        // One macrotask captures a whole burst (the relay cache writes a
        // message's events synchronously), so one readonly check serves it.
        setTimeout(() => void this.flushGate(), 0);
      }
    });
  }

  /**
   * Resolve the queued batch: ONE ids query (pipelined primary-key gets in a
   * readonly transaction — it does not contend with readers the way a
   * readwrite does) splits the batch into rows the store already holds and
   * rows it doesn't. Holds resolve immediately — the store having the row IS
   * the durability every caller is owed, including the one that ACKs a parked
   * wrap on it. Misses proceed to the write path exactly as before.
   */
  private async flushGate(): Promise<void> {
    this.gateScheduled = false;
    const batch = this.gate;
    this.gate = new Map();
    if (batch.size === 0) return;

    let existing = new Set<string>();
    try {
      const rows = await perfTime(
        this.op("precheck"),
        () => this.settled(this.store.query([{ ids: [...batch.keys()] }])),
        (found) => found.length,
      );
      existing = new Set(rows.map((row) => row.id));
    } catch {
      // An unanswerable check means every row is treated as missing — the
      // write path re-writes some rows, which is the pre-gate behaviour.
    }

    for (const [id, entry] of batch) {
      if (existing.has(id)) {
        this.written.add(id);
        perfCount(`db.write ${this.label} (on disk)`, 0, 1, "events");
        for (const settler of entry.settlers) settler.resolve();
        continue;
      }
      // Index entries, not events: Armada replaces Nostrify's single-letter tag
      // policy with `defaultIndexTags`, which indexes EVERY tag under 20 chars —
      // and the tag index is `multiEntry`, so one row is written per entry. A
      // follow list or a big `p`-tagged event is therefore a write of hundreds of
      // index rows dressed as a write of one event, and the count is the only way
      // to see that in a total.
      perfCount("db.index entries", 0, this.indexTags(entry.rumor).length, "entries");
      void perfTime(this.op("write"), async () => {
        await this.settled(this.store.event(toEvent(entry.rumor), entry.opts));
        // AFTER the commit: `resolved` means durable to every caller, and one of
        // them ACKs (destroys) a parked wrap on the strength of it.
        this.written.add(id);
      }).then(
        () => {
          for (const settler of entry.settlers) settler.resolve();
        },
        (error: unknown) => {
          for (const settler of entry.settlers) settler.reject(error);
        },
      );
    }
  }

  async count(
    filters: NostrFilter[],
    opts?: { signal?: AbortSignal },
  ): Promise<{ count: number; approximate: boolean }> {
    const { count, approximate } = await perfTime(this.op("count"), () =>
      this.settled(this.store.count(filters, opts)),
    );
    return { count, approximate: approximate ?? false };
  }

  remove(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<void> {
    // A removed event has to be storable again, and this class cannot evaluate
    // the filter that removed it.
    this.written.forget();
    return perfTime(this.op("remove"), () => this.settled(this.store.remove(filters, opts)));
  }

  close(): Promise<void> {
    return this.store.close();
  }

  [Symbol.toStringTag] = "IndexedDBRumorStore";
}

interface KVSchema extends DBSchema {
  kv: { key: string; value: unknown };
  /**
   * Every tenant id this instance has ever opened — the durable registry a
   * purge needs to find the per-tenant databases on a browser with no
   * `indexedDB.databases()` to enumerate (Firefox). Its own object store
   * rather than a reserved key in `kv`, so it can never collide with a
   * caller's key.
   */
  tenants: { key: string; value: true };
}

/**
 * Bumped when {@link KVSchema} gains a store.
 *
 * This is IndexedDB's own version — the STORE LAYOUT of this one database,
 * upgraded by the transaction below. It is not the data-schema version: what
 * the keys mean and what shape their values are in is `ARMADA_DB_VERSION` in
 * `schema.ts`, which spans every database and both adapters.
 */
const KV_DB_VERSION = 2;

/**
 * KV over its own database, which also holds the tenant registry. Values are
 * stored natively (structured clone), so a JSON round-trip is never paid.
 *
 * Every operation degrades to a no-op when IndexedDB is unavailable (iOS
 * Lockdown Mode, some private-browsing contexts), matching `NIndexedDB`.
 */
class IndexedDBKV implements ArmadaKV {
  private readonly db: Promise<IDBPDatabase<KVSchema> | null>;
  /** Tenant ids already written, so repeated `tenant()` calls stay free. */
  private readonly registered = new Set<string>();

  constructor(name: string) {
    this.db = IndexedDBKV.open(name);
  }

  private static async open(name: string): Promise<IDBPDatabase<KVSchema> | null> {
    if (typeof indexedDB === "undefined") return null;
    try {
      // The cold open is its own milestone: it is the first IndexedDB work of
      // the session and every KV read queues behind it.
      return await perfTime("db.open kv", () =>
        openDB<KVSchema>(name, KV_DB_VERSION, {
          upgrade(db) {
            // Idempotent: an upgrade from v1 already has `kv`, a fresh open has
            // neither.
            if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
            if (!db.objectStoreNames.contains("tenants")) db.createObjectStore("tenants");
          },
        }),
      );
    } catch {
      return null;
    }
  }

  /** Record that `id` has a tenant database (best-effort, fire-and-forget). */
  async rememberTenant(id: string): Promise<void> {
    if (this.registered.has(id)) return;
    this.registered.add(id);
    try {
      const db = await this.db;
      await db?.put("tenants", true, id);
    } catch {
      // A purge still finds open tenants via the in-memory map.
      this.registered.delete(id);
    }
  }

  /** Every tenant id recorded by this or a previous session. */
  async knownTenants(): Promise<string[]> {
    try {
      const db = await this.db;
      return db ? ((await db.getAllKeys("tenants")) as string[]) : [];
    } catch {
      return [];
    }
  }

  /**
   * Operations queued for the next shared transaction, in arrival order.
   *
   * idb's `db.get`/`db.put` shortcuts open one transaction PER CALL — three
   * event-loop tasks each (open, request, complete) — and the callers that
   * matter issue them in bursts (a `KvPrefixCache` warm is `keys()` then a
   * `Promise.all` of one get per key). On a congested boot loop that priced a
   * few-KB read at seconds of queueing: 149 gets averaged 1.6s each, measured.
   * One transaction per burst pays the task overhead once; executing the ops
   * in arrival order inside it keeps read-your-writes exactly as sequential
   * transactions had it.
   */
  private pendingOps: Array<
    | { op: "get"; key: string; resolve: (value: unknown) => void }
    | { op: "set"; key: string; value: unknown; resolve: () => void; reject: (error: unknown) => void }
    | { op: "delete"; key: string; resolve: () => void; reject: (error: unknown) => void }
    | { op: "keys"; prefix?: string; resolve: (keys: string[]) => void }
  > = [];
  /** Whether a flush is already scheduled for the current burst. */
  private opsScheduled = false;

  private scheduleOps(): void {
    if (this.opsScheduled) return;
    this.opsScheduled = true;
    setTimeout(() => void this.flushOps(), 0);
  }

  private async flushOps(): Promise<void> {
    this.opsScheduled = false;
    const ops = this.pendingOps;
    this.pendingOps = [];
    if (ops.length === 0) return;

    const db = await this.db;
    if (!db) {
      // Degraded (no IndexedDB): reads answer their miss value, writes no-op.
      for (const op of ops) {
        if (op.op === "keys") op.resolve([]);
        else if (op.op === "get") op.resolve(undefined);
        else op.resolve();
      }
      return;
    }

    const mode = ops.some((op) => op.op === "set" || op.op === "delete") ? "readwrite" : "readonly";
    try {
      const tx = db.transaction("kv", mode as "readwrite");
      // The cast above narrows the union so `put`/`delete` typecheck; a
      // read-only burst really does open readonly, and never calls them.
      const store = tx.store;
      const results = await Promise.all(
        ops.map((op) =>
          op.op === "get"
            ? store.get(op.key)
            : op.op === "keys"
            ? store.getAllKeys(IndexedDBKV.keyRange(op.prefix))
            : op.op === "set"
            ? store.put(op.value, op.key)
            : store.delete(op.key),
        ),
      );
      await tx.done;
      for (const [i, op] of ops.entries()) {
        if (op.op === "get") op.resolve(results[i] as never);
        else if (op.op === "keys") {
          // The range is a scan hint, not the contract — see `prefixUpperBound`.
          const keys = results[i] as string[];
          op.resolve(op.prefix ? keys.filter((key) => key.startsWith(op.prefix!)) : keys);
        } else op.resolve();
      }
    } catch (error) {
      // Match the per-op contracts from the unbatched days: a failed read is
      // a miss, a failed write rejects to the caller's catch.
      for (const op of ops) {
        if (op.op === "get") op.resolve(undefined);
        else if (op.op === "keys") op.resolve([]);
        else op.reject(error);
      }
    }
  }

  /** The key range covering `prefix` (or everything, without one). */
  private static keyRange(prefix?: string): IDBKeyRange | undefined {
    if (!prefix) return undefined;
    const upper = prefixUpperBound(prefix);
    return upper === undefined
      ? IDBKeyRange.lowerBound(prefix)
      : IDBKeyRange.bound(prefix, upper, false, true);
  }

  get<T>(key: string): Promise<T | undefined> {
    return perfTime("kv.get", () =>
      new Promise<T | undefined>((resolve) => {
        this.pendingOps.push({ op: "get", key, resolve: resolve as (value: unknown) => void });
        this.scheduleOps();
      }));
  }

  set<T>(key: string, value: T): Promise<void> {
    return perfTime("kv.set", () =>
      new Promise<void>((resolve, reject) => {
        // `undefined` is out of contract (it has no JSON form); normalize to
        // null so both adapters agree instead of one storing a hole.
        this.pendingOps.push({ op: "set", key, value: value === undefined ? null : value, resolve, reject });
        this.scheduleOps();
      }));
  }

  delete(key: string): Promise<void> {
    return perfTime("kv.delete", () =>
      new Promise<void>((resolve, reject) => {
        this.pendingOps.push({ op: "delete", key, resolve, reject });
        this.scheduleOps();
      }));
  }

  keys(prefix?: string): Promise<string[]> {
    // Through the same queue as get/set/delete: a `keys()` racing a queued
    // write must observe it (the KvPrefixCache warm is exactly a keys() after
    // fire-and-forget sets), and arrival order inside one transaction is the
    // ordering separate transactions used to provide.
    return perfTime(
      "kv.keys",
      () =>
        new Promise<string[]>((resolve) => {
          this.pendingOps.push({ op: "keys", prefix, resolve });
          this.scheduleOps();
        }),
      (k) => k.length,
      "keys",
    );
  }

  async close(): Promise<void> {
    (await this.db)?.close();
  }
}

export class IndexedDBArmadaDB implements ArmadaDB {
  private readonly stores = new Map<string, IndexedDBRumorStore>();
  private readonly indexTags: (rumor: NostrRumor) => string[][];
  readonly kv: IndexedDBKV;

  /**
   * @param name Prefix for the IndexedDB databases this instance owns:
   *   `${name}:kv` and one `${name}:t:${tenantId}` per tenant.
   */
  constructor(
    private readonly name: string,
    opts: ArmadaDBOpts = {},
  ) {
    this.indexTags = opts.indexTags ?? defaultIndexTags;
    this.kv = new IndexedDBKV(`${name}:kv`);
  }

  tenant(id: string): NRumorStore {
    let store = this.stores.get(id);
    if (!store) {
      // One IndexedDB database per tenant, so each of these is a distinct
      // `openDB` (and a `versionchange` upgrade creating five indexes the first
      // time). The mark counts them: a boot that opens a dozen is paying a dozen
      // cold opens.
      perfMark("db.tenant open", id);
      store = new IndexedDBRumorStore(
        IndexedDBArmadaDB.databaseName(this.name, id),
        this.indexTags,
        tenantClass(id),
      );
      this.stores.set(id, store);
      // Registered on open, not on first write: an empty tenant still has a
      // database, and a purge has to delete that too.
      void this.kv.rememberTenant(id);
    }
    return store;
  }

  /**
   * Every tenant id this instance owns a database for — recorded in the
   * registry, or opened this session and possibly not yet flushed to it.
   */
  async tenantIds(): Promise<string[]> {
    return [...new Set([...(await this.kv.knownTenants()), ...this.stores.keys()])];
  }

  /**
   * The IndexedDB database backing a tenant. Exposed so a purge can delete
   * tenant databases without opening them.
   */
  static databaseName(name: string, tenantId: string): string {
    return `${name}:t:${tenantId}`;
  }

  /** Close every connection this instance opened. */
  async close(): Promise<void> {
    const stores = [...this.stores.values()];
    this.stores.clear();
    await Promise.all([...stores.map((s) => s.close()), this.kv.close()]);
  }

  [Symbol.toStringTag] = "IndexedDBArmadaDB";
}
