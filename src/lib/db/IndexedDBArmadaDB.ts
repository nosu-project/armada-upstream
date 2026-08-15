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
import {
  defaultIndexTags,
  matchesKvRange,
  resolveKvRange,
  TERM_TAG,
  tenantClass,
  termNamespaceRange,
} from "./types";
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

/**
 * The rumor in a row read STRAIGHT out of the delegate's object store, which
 * carries its derived index fields (`_tagsCreated`) alongside the event.
 *
 * Rebuilt field by field rather than by deleting the ones we know about: the
 * delegate may derive more of them in a later release, and a rumor with an extra
 * property is one that compares unequal to the same rumor read any other way.
 */
function rowRumor(row: Record<string, unknown>): NostrRumor {
  return {
    id: row.id as string,
    pubkey: row.pubkey as string,
    created_at: row.created_at as number,
    kind: row.kind as number,
    tags: row.tags as string[][],
    content: row.content as string,
  };
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
  /** A `distinct:` collapse to apply to the rows — see {@link Collapse}. */
  collapse?: Collapse;
  /**
   * The filters this job could be DRIVEN by, when `check` means the delegate
   * can only over-select — see {@link IndexedDBRumorStore.runChecked}. Each is
   * a superset of the answer on its own; the runner picks the one that selects
   * fewest rows and narrows it here.
   */
  drivers?: NostrFilter[];
}

/**
 * A `distinct:<namespace>` collapse: the job's rows are reduced to the newest
 * per term in `namespace` before `limit` is applied.
 *
 * `indexOnly` says the namespace ALONE selects the rows — no ids, kinds,
 * authors, tags or keywords to test — which is the case the tag index can answer
 * by seeking once per group instead of reading every row (see
 * {@link IndexedDBRumorStore.groupScan}). Time bounds don't disqualify it: the
 * index key carries `created_at`.
 */
interface Collapse {
  namespace: string;
  indexOnly: boolean;
  since?: number;
  until?: number;
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

    if (parsed.terms.length === 0 && parsed.distinct === undefined) {
      plain.push(filter);
      continue;
    }

    // A term (or a collapse over one's namespace) in a tenant that derives none
    // can never match, and asking the delegate would drop the constraint and
    // widen the answer instead.
    if (!policy) continue;

    const term = parsed.terms.length > 0 ? { [`#${TERM_TAG}`]: [parsed.terms[0]] } : {};
    const bounded: NostrFilter = { ...term };
    if (filter.since !== undefined) bounded.since = filter.since;
    if (filter.until !== undefined) bounded.until = filter.until;

    if (parsed.distinct !== undefined) {
      // A collapse can never be handed a limit: the delegate counts rows and the
      // filter counts groups, so a limited page would be truncated before it was
      // grouped — which is the whole bug this replaces. Everything else the
      // filter says is applied here, BEFORE the collapse, so the survivor of a
      // group is the newest row that matched rather than the newest row that
      // exists.
      const indexOnly = parsed.terms.length === 0 && !parsed.ids && !parsed.authors &&
        !parsed.kinds && parsed.tags.length === 0 && !parsed.searchKeywords;
      jobs.push({
        // The delegate cannot narrow by a namespace — only by a whole term — so
        // an index-only collapse hands it nothing and is answered by the group
        // scan; anything else is the ordinary read, collapsed afterwards.
        filters: [indexOnly ? {} : bounded],
        check: indexOnly
          ? undefined
          : (rumor) => parsed.matches(rumor) && parsed.matchesTerms(policy(rumor, tenant)),
        limit: filter.limit,
        collapse: {
          namespace: parsed.distinct,
          indexOnly,
          since: filter.since,
          until: filter.until,
        },
      });
      continue;
    }

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

    const rest = restDriver(filter, parsed);
    jobs.push({
      filters: [bounded],
      drivers: rest ? [bounded, rest] : [bounded],
      check: (rumor) => parsed.matches(rumor) && parsed.matchesTerms(policy(rumor, tenant)),
      limit: filter.limit,
    });
  }

  if (plain.length > 0) jobs.unshift({ filters: plain });
  return jobs;
}

/**
 * The filter's NON-term half as a driving filter — everything it says except
 * the term, which the check re-applies anyway — or `undefined` when it isn't
 * worth offering.
 *
 * A term is not always the selective half. The conversation's timer is one row
 * at the very BOTTOM of a thread (`queryDm17Timer`), so driving by the term
 * walks every message ever exchanged to reach it, while kind 1740 is a handful
 * of rows across the whole tenant. Which is cheaper is a property of the data,
 * not of the query, so {@link IndexedDBRumorStore.runChecked} counts both
 * rather than guessing — and this is the candidate it counts against the term.
 *
 * Two things disqualify one, both because the count has to be cheaper than the
 * read it saves:
 *
 *  - Nothing to drive BY. A filter naming only a time window selects the whole
 *    tenant, and counting that is a walk of it.
 *  - A shape `NIndexedDB` can't count from its index alone. Its fast path wants
 *    one "major" field (ids, authors, kinds, or a tag) — or authors and kinds
 *    together, which its `by-pubkey-kind` index covers — and anything else
 *    falls back to running the query, which is exactly the work being avoided.
 *
 * `ids` is the exception that skips the counting entirely: the delegate answers
 * an ids plan with primary-key gets, so it can never be beaten.
 */
function restDriver(filter: NostrFilter, parsed: ParsedFilter): NostrFilter | undefined {
  const { search: _search, limit: _limit, ...rest } = filter;
  if (parsed.ids) return rest;

  const majors = (parsed.authors ? 1 : 0) + (parsed.kinds ? 1 : 0) + parsed.tags.length;
  if (majors === 0) return undefined;
  if (majors > 1 && !(majors === 2 && parsed.authors && parsed.kinds)) return undefined;
  return rest;
}

/** Run the jobs, merge them by id and put them back in the store's order. */
function mergeJobs(results: NostrRumor[][]): NostrRumor[] {
  if (results.length === 1) return results[0];
  const byId = new Map<string, NostrRumor>();
  for (const rumors of results) for (const rumor of rumors) byId.set(rumor.id, rumor);
  return [...byId.values()].sort(compareNewest);
}

/** Newest first, ties by id — the order every read comes back in. */
function compareNewest(a: NostrRumor, b: NostrRumor): number {
  if (a.created_at !== b.created_at) return b.created_at - a.created_at;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The one term of `derived` in `namespace` — which group a rumor collapses into
 * — or `undefined` when it has none.
 */
function keyIn(namespace: string, derived: string[]): string | undefined {
  const prefix = `${namespace}:`;
  return derived.find((term) => term.startsWith(prefix));
}

/**
 * The object store and index `NIndexedDB` keeps its rows in, which
 * {@link IndexedDBRumorStore.groupScan} reads directly.
 *
 * Reaching into the delegate's own database is a coupling, and a deliberate one:
 * enumerating the DISTINCT values of an index is not something any store API
 * exposes, and it is the whole difference between one seek per conversation and
 * a walk of every rumor. Every use is guarded and falls back to the walk, so a
 * Nostrify release that renamed either of these would make the conversation list
 * slower and nothing else. Its schema version is 1 and this opens at 1 with an
 * upgrade that throws, so a database that does not exist yet is NOT created
 * half-formed — the aborted upgrade reverts it.
 */
const DELEGATE = { store: "events", tagIndex: "by-tag", version: 1 } as const;

/** How many rumors one page of the term backfill re-indexes. */
const BACKFILL_PAGE = 500;

/**
 * The largest range a checked read will take WHOLE rather than page through —
 * see {@link IndexedDBRumorStore.runChecked}.
 *
 * The delegate answers an unlimited filter with one `getAll` and a limited one
 * with a cursor step per row, so for a small range the whole thing in one
 * request beats a walk of part of it. Sized as a page of rows worth
 * deserializing to answer any single query, since that is the cost when the
 * check then throws most of them away.
 */
const CHECKED_PAGE = 128;

/**
 * A loop guard on a checked read's paging, not a budget on it.
 *
 * Paging must be EXHAUSTIVE: the read it replaces fetched the whole range and
 * filtered it, so a page limit doubling as a search budget would turn a rumor
 * that exists into one the store denies having — a timer set a year ago
 * reported as "no timer", not as a slow read. Every round therefore either
 * advances `until` strictly downward or widens the page, so the walk reaches
 * the end of the range on its own and this is only reached if a delegate
 * answers in a way that makes neither true.
 */
const CHECKED_MAX_PAGES = 1024;

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
  /** The second, read-only handle {@link groupScan} walks. Opened at most once. */
  private raw?: Promise<IDBPDatabase | null>;

  constructor(
    private readonly name: string,
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
   *
   * A generation bump needs nothing more than the same pass. Terms live in the
   * row's own index entries here, and a re-`put` REPLACES them wholesale, so a
   * term the policy no longer derives cannot survive — unlike the SQLite
   * engines, where the index is a table beside the rumors and stale rows have to
   * be deleted first.
   */
  installTerms(
    policy: TermPolicy,
    done: () => Promise<boolean>,
    finish: () => Promise<void>,
  ): void {
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
   * that reach the term index wait; an ordinary read is unaffected by a
   * half-built one, and queueing it behind a full pass over the tenant would put
   * that pass in front of the first thing the UI asks for.
   *
   * The test is whether a filter carries a `search` AT ALL, and must stay that
   * way: `distinct:<namespace>` reads the index while parsing to no term of its
   * own, so a gate on `ParsedFilter.terms` would let the conversation list —
   * the one read that is nothing BUT a collapse — group over an index nothing
   * had built. That is exactly what the Kotlin and Swift ports did.
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
          if (job.collapse) {
            const rumors = await this.runCollapse(job, job.collapse, opts);
            returned += rumors.length;
            return rumors;
          }
          if (job.check) {
            const rumors = await this.runChecked(job, opts);
            returned += rumors.length;
            return rumors;
          }
          const events = await this.store.query(job.filters, opts);
          returned += events.length;
          let rumors = events.map(toRumor);
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
   * One job the delegate can only over-select: read the cheaper of its
   * {@link DelegateJob.drivers}, and narrow what comes back here.
   *
   * The narrowing is unavoidable — a derived term lives in the index and
   * nowhere else, so the moment a filter names anything besides one, the
   * delegate has to be asked for a superset (see {@link planFilters}). What is
   * avoidable is asking for a superset the size of the conversation. Two things
   * do that:
   *
   *  - **The cheaper driver wins.** Both candidates contain the answer, so
   *    either may be read; one `count` each — index-only in the delegate, no
   *    rows deserialized — says which is smaller. A thread page is the term
   *    (every kind is in the thread); the same thread's TIMER is the kind (one
   *    row per conversation, against every message ever sent in one).
   *  - **A limit is paged, not dropped.** The delegate can't be handed the
   *    filter's limit, because rows this check rejects would count against it
   *    and the page would come back short. Reading the whole range instead
   *    made a 50-row page of a 1200-message thread deserialize all 1200. Pages
   *    of {@link CHECKED_PAGE} walk down `until` until the limit is met, so the
   *    cost is the answer's, and only a filter whose check rejects nearly
   *    everything pays for more than one.
   */
  private async runChecked(
    job: DelegateJob,
    opts?: { signal?: AbortSignal },
  ): Promise<NostrRumor[]> {
    const check = job.check ?? (() => true);
    const { driver, rows } = await this.chooseDriver(job, opts);

    // A range small enough to hold in memory is read whole, in ONE request,
    // rather than walked a page at a time — the delegate answers an unlimited
    // filter with `getAll` and a limited one with a cursor step per row. This is
    // the timer read: a handful of rows tenant-wide, and the count that chose
    // the driver already said so.
    if (job.limit === undefined || (rows !== undefined && rows <= CHECKED_PAGE)) {
      const events = await this.store.query([driver], opts);
      const rumors = events.map(toRumor).filter(check);
      return job.limit === undefined ? rumors : rumors.slice(0, job.limit);
    }

    const kept: NostrRumor[] = [];
    const seen = new Set<string>();
    let until = driver.until;
    // The first page is exactly what was asked for, so a check that rejects
    // nothing — a thread page, where every kind in the filter is in the thread
    // — costs one round trip and not one row more.
    let page = job.limit;

    for (let round = 0; round < CHECKED_MAX_PAGES && kept.length < job.limit; round++) {
      const filter: NostrFilter = { ...driver, limit: page };
      if (until !== undefined) filter.until = until;

      const events = await this.store.query([filter], opts);
      let fresh = 0;
      let oldest = Infinity;

      for (const event of events) {
        oldest = Math.min(oldest, event.created_at);
        if (seen.has(event.id)) continue;
        seen.add(event.id);
        fresh++;
        const rumor = toRumor(event);
        if (check(rumor) && kept.length < job.limit) kept.push(rumor);
      }

      // A short page is the end of the range, whatever the limit still wants.
      if (events.length < page) break;
      // `until` is INCLUSIVE, so the next page re-reads the boundary second
      // rather than stepping over the rows sharing it; `seen` drops the
      // repeats. Stepping below it would silently lose every other rumor
      // written in that second. When a page was ENTIRELY repeats, one second
      // holds more rows than the page does and no `until` can get past it —
      // which the widening below is what rescues.
      if (fresh > 0) until = oldest;
      // Reaching here means the check is selective, so widen fast rather than
      // pay a round trip per `limit` rows of a range that mostly fails it.
      page *= 4;
    }

    return kept;
  }

  /**
   * Which of a job's drivers to read: the one selecting fewest rows.
   *
   * An `ids` driver skips the counting — the delegate answers those with
   * primary-key gets, so nothing can beat it — and a count that fails is read
   * as "unusable", never as "cheapest", so a delegate that can't answer one
   * leaves the term driving exactly as it did before.
   */
  private async chooseDriver(
    job: DelegateJob,
    opts?: { signal?: AbortSignal },
  ): Promise<{ driver: NostrFilter; rows?: number }> {
    const drivers = job.drivers ?? job.filters;
    if (drivers.length === 1) return { driver: drivers[0] };

    const ids = drivers.find((driver) => driver.ids !== undefined);
    if (ids) return { driver: ids, rows: ids.ids?.length };

    const counts = await Promise.all(drivers.map(async (driver) => {
      try {
        // Without a limit, so the delegate answers from its index alone.
        const { limit: _limit, ...unlimited } = driver;
        return (await this.store.count([unlimited], opts)).count;
      } catch {
        return Infinity;
      }
    }));

    let best = 0;
    for (let i = 1; i < drivers.length; i++) if (counts[i] < counts[best]) best = i;
    return {
      driver: drivers[best],
      rows: Number.isFinite(counts[best]) ? counts[best] : undefined,
    };
  }

  /**
   * One collapsed job: the newest rumor per term in a namespace.
   *
   * Two ways to get there, and they must answer identically — the conformance
   * suite asserts it, because which one runs is an optimization the caller
   * cannot see. {@link groupScan} seeks once per group and reads only the rows it
   * returns; the fallback reads what the filter selects and keeps the first of
   * each group. The fallback is the one that can honour a row condition, and it
   * is also what a browser whose delegate layout this build doesn't recognize
   * gets — slower, never wrong.
   */
  private async runCollapse(
    job: DelegateJob,
    collapse: Collapse,
    opts?: { signal?: AbortSignal },
  ): Promise<NostrRumor[]> {
    const policy = this.terms;
    if (!policy) return [];

    if (collapse.indexOnly) {
      const scanned = await this.groupScan(collapse);
      if (scanned) {
        const sorted = scanned.sort(compareNewest);
        return job.limit === undefined ? sorted : sorted.slice(0, job.limit);
      }
    }

    const events = await this.store.query(job.filters, opts);
    let rumors = events.map(toRumor);
    if (job.check) rumors = rumors.filter(job.check);
    rumors.sort(compareNewest);

    const groups = new Set<string>();
    const kept: NostrRumor[] = [];

    for (const rumor of rumors) {
      if (job.limit !== undefined && kept.length >= job.limit) break;
      // A rumor with no term in the namespace belongs to no group and is
      // excluded — the same "no term, no match" a term lookup gives.
      const key = keyIn(collapse.namespace, policy(rumor, this.tenantId));
      if (key === undefined || groups.has(key)) continue;
      groups.add(key);
      kept.push(rumor);
    }

    return kept;
  }

  /**
   * Every group in `namespace`, each as its newest rumor, by seeking the tag
   * index once per group.
   *
   * A loose index scan: the index key is `[name, value, created_at]`, so one
   * DESCENDING cursor over the namespace's range starts at the newest entry of
   * the last term, and `continue([TERM_TAG, term, -Infinity])` jumps to the
   * newest entry of the term before it — a seek per group rather than a step per
   * row. `openCursor` hands back the row itself, so the rumors come out of the
   * same walk.
   *
   * Every group is enumerated even when the filter had a `limit`, because the
   * walk is in TERM order and the limit is by recency: which groups are newest
   * isn't known until they all are. That is a seek per conversation, not per
   * message, which is the point.
   *
   * Returns `undefined` if the delegate's database isn't there to read, or isn't
   * laid out the way this expects — the caller then falls back to the walk.
   */
  private async groupScan(collapse: Collapse): Promise<NostrRumor[] | undefined> {
    const range = termNamespaceRange(collapse.namespace);
    if (!range) return undefined;

    try {
      const db = await this.delegateDb();
      if (!db) return undefined;

      const index = db.transaction(DELEGATE.store, "readonly")
        .objectStore(DELEGATE.store)
        .index(DELEGATE.tagIndex);

      const bounds = IDBKeyRange.bound(
        [TERM_TAG, range.lower, -Infinity],
        range.upper === undefined ? [TERM_TAG, [], -Infinity] : [TERM_TAG, range.upper, -Infinity],
        false,
        true,
      );

      const found: NostrRumor[] = [];
      let cursor = await index.openCursor(bounds, "prev");

      while (cursor) {
        const key = cursor.key as [string, string, number];
        const term = key[1];
        const at = key[2];

        // The newest entry of this group is above the window: seek down inside
        // the same group. The result may land in an earlier one, which the next
        // turn of the loop reads as such.
        if (collapse.until !== undefined && at > collapse.until) {
          cursor = await cursor.continue([TERM_TAG, term, collapse.until]);
          continue;
        }

        // …and if the NEWEST entry of the group is already too old, no entry of
        // it can qualify, so the whole group is skipped rather than walked.
        if (collapse.since !== undefined && at < collapse.since) {
          cursor = await cursor.continue([TERM_TAG, term, -Infinity]);
          continue;
        }

        found.push(rowRumor(cursor.value as Record<string, unknown>));
        cursor = await cursor.continue([TERM_TAG, term, -Infinity]);
      }

      return found;
    } catch {
      // A layout this build doesn't recognize, a database that isn't there, or a
      // key type the engine won't compare. All of them mean "read it the slow
      // way", never "answer with less".
      return undefined;
    }
  }

  /**
   * A read-only handle on the delegate's own database, or `undefined` when there
   * isn't one to open.
   *
   * Opened at the delegate's schema version with an upgrade that throws, so this
   * can only ever attach to a database `NIndexedDB` already created: a database
   * that doesn't exist would run the upgrade, and the throw aborts the
   * versionchange transaction, which reverts the creation. Opening it
   * version-less instead would leave behind an empty database with no object
   * store, at the version the delegate expects — and the delegate would then
   * never run its own upgrade, so the tenant would be permanently broken.
   */
  private delegateDb(): Promise<IDBPDatabase | null> {
    this.raw ??= (async () => {
      if (typeof indexedDB === "undefined") return null;
      try {
        return await openDB(this.name, DELEGATE.version, {
          upgrade() {
            throw new Error("not this adapter's database to create");
          },
          blocking(_current, _blocked, event) {
            // A newer layout wants in. Let go of it: the group scan is an
            // optimization, and the fallback needs no handle.
            (event.target as IDBDatabase | null)?.close();
          },
        });
      } catch {
        return null;
      }
    })();
    return this.raw;
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
    // two jobs both found. A collapsed read counts GROUPS, which is likewise
    // only knowable from the rows.
    if (jobs.length > 1 || jobs[0].check || jobs[0].collapse) {
      return { count: (await this.query(filters, opts)).length, approximate: false };
    }
    const { count, approximate } = await perfTime(this.op("count"), () =>
      this.settled(this.store.count(jobs[0].filters, opts)),
    );
    return { count, approximate: approximate ?? false };
  }

  async remove(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<void> {
    await this.awaitTerms(filters);
    // A `distinct:` collapse names one rumor per group, which is not something a
    // deletion can coherently be asked for — and answering it as written would
    // delete the newest message of every conversation. Dropped BEFORE planning,
    // so it is gone from the id fallback below too, which resolves the filters by
    // reading them.
    const deletable = filters.filter((filter) => new ParsedFilter(filter).distinct === undefined);
    if (deletable.length === 0) return;
    // Nothing matches, so nothing is removed — and `written` keeps its ids,
    // since no row left the store.
    const jobs = planFilters(deletable, this.tenantId, this.terms);
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
      const ids = (await this.query(deletable, opts)).map((rumor) => rumor.id);
      if (ids.length === 0) return;
      target = [{ ids }];
    }
    await perfTime(this.op("remove"), () => this.settled(this.store.remove(target, opts)));
  }

  async close(): Promise<void> {
    const raw = this.raw;
    this.raw = undefined;
    (await raw)?.close();
    await this.store.close();
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
   * Tenant ids whose existing rows have been through their `TermPolicy`, valued
   * by the GENERATION of that policy — the marker that makes the term backfill
   * run once per browser rather than once per boot, and run again when a policy
   * changes what it derives. `rumor_term_tenants` is the same record in the
   * SQLite engines.
   *
   * An install predating generations holds `true` here, which matches no
   * generation and so simply re-runs the pass once.
   */
  termed: { key: string; value: number | true };
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

  /**
   * Whether `id`'s existing rows have already been through generation
   * `generation` of its term policy.
   *
   * A value that isn't the generation asked for — an older number, or the bare
   * `true` an install predating generations wrote — is treated as not done, so
   * the pass runs again under the new derivation.
   */
  async isTermed(id: string, generation: number): Promise<boolean> {
    try {
      const db = await this.db;
      return (await db?.get("termed", id)) === generation;
    } catch {
      // Unanswerable: treated as not done, so the backfill runs again. A
      // re-`put` of a row already indexed changes nothing.
      return false;
    }
  }

  /** Record that `id`'s backfill has completed for `generation` (best-effort). */
  async setTermed(id: string, generation: number): Promise<void> {
    try {
      const db = await this.db;
      await db?.put("termed", generation, id);
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
        () => this.kv.isTermed(id, opts.termsGeneration ?? 0),
        () => this.kv.setTermed(id, opts.termsGeneration ?? 0),
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
