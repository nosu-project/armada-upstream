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

import { ParsedFilter } from "./ParsedFilter";
import { defaultIndexTags, matchesKvRange, resolveKvRange, TERM_TAG, tenantClass } from "./types";
import { WrittenIds } from "./writtenIds";

import type { NostrEvent, NostrFilter } from "@nostrify/nostrify";
import type { DBSchema, IDBPDatabase } from "idb";
import type { NostrRumor } from "@/lib/nostrRumor";
import type {
  ArmadaDB,
  ArmadaDBOpts,
  ArmadaKV,
  ArmadaKVEntry,
  ArmadaKVListOptions,
  ArmadaKVSelector,
  KvRange,
  NRumorStore,
  TenantOpts,
  TermPolicy,
} from "./types";

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

/**
 * One call to the delegate, and what the caller must still do to its answer.
 *
 * Most reads are a single job with nothing to do: the delegate's answer IS the
 * answer. A job with a `check` is one the delegate can only over-select.
 */
interface DelegateJob {
  /** The filters as `NIndexedDB` should receive them. */
  filters: NostrFilter[];
  /** Applied to every row the delegate returned, when it over-selects. */
  check?: (rumor: NostrRumor) => boolean;
  /** Re-applied after `check`, since the delegate could not be given it. */
  limit?: number;
}

/**
 * Plan a read against a tenant whose terms are indexed under {@link TERM_TAG}.
 *
 * A term has to become an ordinary tag filter, `indexTags` being the only place
 * `NIndexedDB` lets an index term exist at all — and that is exact only while
 * the term is the ONLY thing the delegate is asked for. Its planner re-checks a
 * tag filter against the event's literal tags whenever the plan isn't
 * index-only, and a term is not among them: it lives in the index and nowhere
 * else, which is the whole point. So a filter naming a term alone is handed
 * over as written, limit and all, and one naming anything besides is handed
 * over as the term alone — an index seek down one term's rows — with the rest
 * of the filter, and its limit, applied here.
 *
 * That is also why a term-bearing filter gets a job to itself. Filters are OR'd
 * and each carries its own limit, and neither survives being merged into one
 * over-selecting call.
 *
 * An empty result means nothing can match — every filter either failed closed
 * or named a term in a tenant that derives none.
 *
 * Failing closed is the other half of this, and it is why the filters are
 * parsed here at all. `NIndexedDB` implements NIP-50 itself, and its parse
 * REMOVES the extension tokens it doesn't support — so `domain:example.com`
 * would reach its planner with no keywords left and be answered with the whole
 * tenant. Dropping such a filter keeps the web adapter narrowing where the
 * SQLite engines narrow (see `ParsedFilter`'s `search` branch), and keeps
 * `remove()` from deleting a tenant it was asked to narrow.
 *
 * Only filters that actually carry a `search` are parsed, so the hot read path
 * (ids, authors, tags) never pays for any of this, and everything else — an
 * unsatisfiable `{ ids: [] }`, say — reaches the delegate exactly as before.
 */
function planFilters(
  filters: NostrFilter[],
  tenant: string,
  policy: TermPolicy | undefined,
): DelegateJob[] {
  if (!filters.some((f) => typeof f.search === "string")) return [{ filters }];

  const plain: NostrFilter[] = [];
  const jobs: DelegateJob[] = [];

  for (const filter of filters) {
    if (typeof filter.search !== "string") {
      plain.push(filter);
      continue;
    }

    const parsed = new ParsedFilter(filter);
    if (parsed.neverMatch) continue;

    if (parsed.terms.length === 0) {
      plain.push(filter);
      continue;
    }

    // A term in a tenant that derives none can never match, and asking the
    // delegate would drop the constraint and widen the answer instead.
    if (!policy) continue;

    const term = { [`#${TERM_TAG}`]: [parsed.terms[0]] };
    const bounded: NostrFilter = { ...term };
    if (filter.since !== undefined) bounded.since = filter.since;
    if (filter.until !== undefined) bounded.until = filter.until;

    // Nothing but the term (and the time window, which the delegate folds into
    // its key range rather than re-checking): the tag index answers it exactly.
    if (
      parsed.terms.length === 1 && !parsed.ids && !parsed.authors && !parsed.kinds &&
      parsed.tags.length === 0 && !parsed.searchKeywords
    ) {
      if (filter.limit !== undefined) bounded.limit = filter.limit;
      plain.push(bounded);
      continue;
    }

    jobs.push({
      filters: [bounded],
      check: (rumor) => parsed.matches(rumor) && parsed.matchesTerms(policy(rumor, tenant)),
      limit: filter.limit,
    });
  }

  if (plain.length > 0) jobs.unshift({ filters: plain });
  return jobs;
}

/** Run the jobs, merge them by id and put them back in the store's order. */
function mergeJobs(results: NostrRumor[][]): NostrRumor[] {
  if (results.length === 1) return results[0];
  const byId = new Map<string, NostrRumor>();
  for (const rumors of results) for (const rumor of rumors) byId.set(rumor.id, rumor);
  return [...byId.values()].sort((a, b) =>
    a.created_at !== b.created_at ? b.created_at - a.created_at : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  );
}

/** How many rumors one page of the term backfill re-indexes. */
const BACKFILL_PAGE = 500;

class IndexedDBRumorStore implements NRumorStore {
  private readonly store: NIndexedDB;
  /** Profiler label — the tenant's class, see {@link tenantClass}. */
  private readonly label: string;
  private readonly indexTags: (rumor: NostrRumor) => string[][];
  /**
   * The tenant's {@link TermPolicy}, or `undefined` while it has none.
   *
   * Read through a closure by the `indexTags` hook below rather than captured,
   * so a policy declared after the store was first acquired still governs every
   * later write — the binding is to the TENANT, and a tenant is one store
   * however many times it is asked for.
   */
  private terms?: TermPolicy;
  /** The one-time pass over rows written before the policy was installed. */
  private backfill?: Promise<void>;
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

  constructor(
    name: string,
    indexTags: (rumor: NostrRumor) => string[][],
    label: string,
    private readonly tenantId: string,
  ) {
    // Derived terms ride in the ORDINARY tag index under the reserved
    // `TERM_TAG` name, because `indexTags` is the only place `NIndexedDB` lets
    // an index term be added at all — there is no second index to give them.
    // `defaultIndexTags` refuses that name, so nothing a sender writes can
    // reach the namespace.
    this.store = new NIndexedDB(name, {
      indexTags: (event) => {
        const tags = indexTags(event);
        const policy = this.terms;
        if (!policy) return tags;
        return [...tags, ...policy(event, tenantId).map((term) => [TERM_TAG, term])];
      },
    });
    this.label = label;
    this.indexTags = indexTags;
  }

  /**
   * Bind the tenant's {@link TermPolicy}, and index the rows written before it
   * against it.
   *
   * The backfill is a re-`put` of every stored rumor: `indexTags` runs on write
   * and nowhere else, so a row already on disk carries no term until it is
   * written again. It goes through `NIndexedDB` directly rather than this
   * class's `event()`, whose whole job is to skip a write of a row the store
   * already holds.
   */
  installTerms(policy: TermPolicy, done: () => Promise<boolean>, finish: () => Promise<void>): void {
    if (this.terms === policy) return;
    this.terms = policy;
    this.backfill = (async () => {
      if (await done()) return;
      let until: number | undefined;
      for (;;) {
        const page = await this.store.query([{ limit: BACKFILL_PAGE, until }]);
        if (page.length === 0) break;
        await Promise.all(page.map((event) => this.store.event(event)));
        const oldest = page[page.length - 1].created_at;
        // Paged by `until`, which is INCLUSIVE, so a page that ends inside a
        // run of equal timestamps would otherwise repeat forever. Stepping
        // below the oldest one re-reads at worst that timestamp's rows, and
        // a re-put is idempotent.
        if (until !== undefined && oldest >= until) break;
        until = oldest;
        if (page.length < BACKFILL_PAGE) break;
      }
      await finish();
    })().catch(() => {});
  }

  /**
   * Wait for the term backfill, if a read is about to depend on it. Only reads
   * that name a term wait; an ordinary read is unaffected by a half-built term
   * index, and queueing it behind a full pass over the tenant would put that
   * pass in front of the first thing the UI asks for.
   */
  private async awaitTerms(filters: NostrFilter[]): Promise<void> {
    if (!this.backfill) return;
    if (!filters.some((filter) => typeof filter.search === "string")) return;
    await this.backfill;
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
    await this.awaitTerms(filters);
    const jobs = planFilters(filters, this.tenantId, this.terms);
    if (jobs.length === 0) return [];
    // Rows RETURNED, not rows walked — the planner walks more than it yields
    // (an under-filled `limit` walks its whole index range), so a high mean with
    // a low row count is the signature of a scan and worth reading as one.
    let returned = 0;
    const results = await perfTime(
      this.op("query"),
      () =>
        this.settled(Promise.all(jobs.map(async (job) => {
          const events = await this.store.query(job.filters, opts);
          returned += events.length;
          let rumors = events.map(toRumor);
          if (job.check) rumors = rumors.filter(job.check);
          if (job.limit !== undefined && rumors.length > job.limit) rumors = rumors.slice(0, job.limit);
          return rumors;
        }))),
      () => returned,
    );
    // Same elapsed time, bucketed by what was asked instead of by tenant — so a
    // total can be attributed to a caller rather than only to a store.
    perfCount(`shape ${this.label} ${filterShape(filters)}`, 0, returned);
    return mergeJobs(results);
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
    await this.awaitTerms(filters);
    const jobs = planFilters(filters, this.tenantId, this.terms);
    if (jobs.length === 0) return { count: 0, approximate: false };
    // Anything the delegate can only over-select has to be counted from the
    // rows themselves — its own count would include the ones `check` drops —
    // and so does a multi-job read, whose counts would double-count a rumor
    // two jobs both found.
    if (jobs.length > 1 || jobs[0].check) {
      return { count: (await this.query(filters, opts)).length, approximate: false };
    }
    const { count, approximate } = await perfTime(this.op("count"), () =>
      this.settled(this.store.count(jobs[0].filters, opts)),
    );
    return { count, approximate: approximate ?? false };
  }

  async remove(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<void> {
    await this.awaitTerms(filters);
    // Nothing matches, so nothing is removed — and `written` keeps its ids,
    // since no row left the store.
    const jobs = planFilters(filters, this.tenantId, this.terms);
    if (jobs.length === 0) return;
    // A removed event has to be storable again, and this class cannot evaluate
    // the filter that removed it.
    this.written.forget();
    // Anything over-selecting is resolved to ids first: handing the delegate a
    // widened filter would delete the rows `check` was there to spare.
    let target: NostrFilter[];
    if (jobs.length === 1 && !jobs[0].check) {
      target = jobs[0].filters;
    } else {
      const ids = (await this.query(filters, opts)).map((rumor) => rumor.id);
      if (ids.length === 0) return;
      target = [{ ids }];
    }
    await perfTime(this.op("remove"), () => this.settled(this.store.remove(target, opts)));
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
  /**
   * Tenant ids whose existing rows have been through their `TermPolicy` — the
   * marker that makes the term backfill run once per browser rather than once
   * per boot. `rumor_term_tenants` is the same record in the SQLite engines.
   */
  termed: { key: string; value: true };
}

/**
 * Bumped when {@link KVSchema} gains a store.
 *
 * This is IndexedDB's own version — the STORE LAYOUT of this one database,
 * upgraded by the transaction below. It is not the data-schema version: what
 * the keys mean and what shape their values are in is `ARMADA_DB_VERSION` in
 * `schema.ts`, which spans every database and both adapters.
 */
const KV_DB_VERSION = 3;

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
            // Idempotent: an upgrade from an earlier version already has the
            // stores it added, a fresh open has none of them.
            if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
            if (!db.objectStoreNames.contains("tenants")) db.createObjectStore("tenants");
            if (!db.objectStoreNames.contains("termed")) db.createObjectStore("termed");
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

  /** Whether `id`'s existing rows have already been through its term policy. */
  async isTermed(id: string): Promise<boolean> {
    try {
      const db = await this.db;
      return (await db?.get("termed", id)) === true;
    } catch {
      // Unanswerable: treated as not done, so the backfill runs again. A
      // re-`put` of a row already indexed changes nothing.
      return false;
    }
  }

  /** Record that `id`'s backfill has completed (best-effort). */
  async setTermed(id: string): Promise<void> {
    try {
      const db = await this.db;
      await db?.put("termed", true, id);
    } catch {
      // The pass simply runs again next boot.
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
   * matter issue them in bursts (drafts and cursors written as the user types,
   * a boot that warms every `KvPrefixCache` prefix at once). On a congested
   * boot loop that priced a few-KB read at seconds of queueing: 149 gets
   * averaged 1.6s each, measured. One transaction per burst pays the task
   * overhead once; executing the ops in arrival order inside it keeps
   * read-your-writes exactly as sequential transactions had it.
   */
  private pendingOps: Array<
    | { op: "get"; key: string; resolve: (value: unknown) => void }
    | { op: "set"; key: string; value: unknown; resolve: () => void; reject: (error: unknown) => void }
    | { op: "delete"; key: string; resolve: () => void; reject: (error: unknown) => void }
    | {
      op: "list";
      range: KvRange;
      opts: ArmadaKVListOptions;
      resolve: (entries: ArmadaKVEntry<unknown>[]) => void;
    }
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
        if (op.op === "list") op.resolve([]);
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
        ops.map((op) => {
          if (op.op === "get") return store.get(op.key);
          if (op.op === "set") return store.put(op.value, op.key);
          if (op.op === "delete") return store.delete(op.key);
          // Keys and values as two `getAll`s over the identical range rather
          // than a cursor walk: a cursor is a round trip per row inside the
          // transaction, and these two come back in the same order, so zipping
          // them pairs each key with its own value.
          const query = IndexedDBKV.keyRange(op.range);
          const count = IndexedDBKV.scanCount(op.range, op.opts);
          return Promise.all([store.getAllKeys(query, count), store.getAll(query, count)]);
        }),
      );
      await tx.done;
      for (const [i, op] of ops.entries()) {
        if (op.op === "get") op.resolve(results[i] as never);
        else if (op.op === "list") {
          const [keys, values] = results[i] as [string[], unknown[]];
          let entries = keys.map((key, j) => ({ key, value: values[j] }));
          // The range is a scan hint, not the contract — see `matchesKvRange`.
          if (!op.range.exact) entries = entries.filter((entry) => matchesKvRange(entry.key, op.range));
          if (op.opts.reverse) entries.reverse();
          const { limit } = op.opts;
          op.resolve(limit !== undefined && entries.length > limit ? entries.slice(0, limit) : entries);
        } else op.resolve();
      }
    } catch (error) {
      // Match the per-op contracts from the unbatched days: a failed read is
      // a miss, a failed write rejects to the caller's catch.
      for (const op of ops) {
        if (op.op === "get") op.resolve(undefined);
        else if (op.op === "list") op.resolve([]);
        else op.reject(error);
      }
    }
  }

  /** The key range `range` scans (everything, when it is unbounded). */
  private static keyRange(range: KvRange): IDBKeyRange | undefined {
    const { lower, upper } = range;
    if (lower === undefined && upper === undefined) return undefined;
    if (upper === undefined) return IDBKeyRange.lowerBound(lower!);
    if (lower === undefined) return IDBKeyRange.upperBound(upper, true);
    return IDBKeyRange.bound(lower, upper, false, true);
  }

  /**
   * How many rows to ask the scan for, or `undefined` for all of them.
   *
   * `getAll` counts from the LOWER end of the range, so a `limit` can only be
   * pushed down when the front of the scan is the front of the answer: nothing
   * gets filtered out (see {@link KvRange.exact}) and the order isn't about to
   * be reversed.
   */
  private static scanCount(range: KvRange, opts: ArmadaKVListOptions): number | undefined {
    return range.exact && !opts.reverse ? opts.limit : undefined;
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

  // `async` so a selector this refuses rejects rather than throwing where the
  // caller has no promise yet — the other adapters resolve theirs inside one.
  async list<T>(
    selector?: ArmadaKVSelector,
    opts: ArmadaKVListOptions = {},
  ): Promise<ArmadaKVEntry<T>[]> {
    const range = resolveKvRange(selector);
    if (range.empty) return [];
    // Through the same queue as get/set/delete: a `list()` racing a queued write
    // must observe it (a `KvPrefixCache` warm is exactly a list() after
    // fire-and-forget sets), and arrival order inside one transaction is the
    // ordering separate transactions used to provide.
    return perfTime(
      "kv.list",
      () =>
        new Promise<ArmadaKVEntry<T>[]>((resolve) => {
          this.pendingOps.push({
            op: "list",
            range,
            opts,
            resolve: resolve as (entries: ArmadaKVEntry<unknown>[]) => void,
          });
          this.scheduleOps();
        }),
      (entries) => entries.length,
      "entries",
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

  tenant(id: string, opts: TenantOpts = {}): NRumorStore {
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
        id,
      );
      this.stores.set(id, store);
      // Registered on open, not on first write: an empty tenant still has a
      // database, and a purge has to delete that too.
      void this.kv.rememberTenant(id);
    }
    if (opts.terms) {
      store.installTerms(
        opts.terms,
        () => this.kv.isTermed(id),
        () => this.kv.setTermed(id),
      );
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
