/**
 * The SQLite adapter for {@link ArmadaDB} — a port of Nostrify's `NSQLite`
 * (itself a port of strfry's LMDB query engine) with a `tenant` column
 * threaded through every table and index. See sqliteSchema.ts for the layout.
 *
 * One connection, one database: every tenant shares the `rumors` /
 * `rumor_tags` / `rumor_coords` tables, and the KV store is a fourth table.
 *
 * SQLite is used as a key/value store plus hand-maintained indexes — there are
 * no joins anywhere in this file. The planner here, not SQLite's, picks the
 * index a filter scans (`INDEXED BY` forces it), by the same priority cascade
 * strfry uses:
 *
 *   ids → most-selective #tag → pubkey+kind (<1000 combos) → pubkey → kind →
 *   full created_at scan
 *
 * Scanning is two-phase: read candidate keys from the chosen index (which
 * covers `(…, created_at DESC, id ASC)`, so no rumor bodies are touched), then
 * fetch those keys' values in one lookup. Conditions the index can't express
 * are matched in memory, and the scan pages by keyset until the filter's limit
 * is met, so memory stays bounded. A scan the SQL fully satisfies skips phase
 * two and reads the bodies straight off the covering scan.
 *
 * Semantics, matching the IndexedDB adapter:
 *
 *  - Ephemeral kinds (20000–29999) are never stored.
 *  - Replaceable (0, 3, 10000–19999) and addressable (30000–39999) rumors
 *    supersede older versions at the same (tenant, kind, pubkey, d)
 *    coordinate; a stale write is skipped. NIP-01 tie-break: on equal
 *    created_at the smaller id wins.
 *  - NIP-09 kind-5 deletion requests are applied on write (`e` by id, `a` by
 *    coordinate), only against the requester's own rumors in the same tenant;
 *    the request itself is retained.
 *  - Writes are batched across ALL tenants: `event()` queues, and the burst
 *    commits as ONE transaction on the next microtask. The returned promise
 *    resolves only once that transaction has committed, and rejects if it
 *    failed.
 *
 * Deliberate divergences from `NSQLite`:
 *
 *  - No deletion tombstone check on write. NSQLite refuses to re-admit an
 *    event a stored kind 5 already deleted, at the cost of an index seek per
 *    write; `NIndexedDB` (and so the IndexedDB adapter) has no such check, and
 *    the adapters have to agree.
 *  - Reads and writes interleave on one connection inside `BEGIN IMMEDIATE`,
 *    so unlike the old `SqliteEventStore` this is NOT written as guarded,
 *    read-free SQL. A second writer on the same file (the Android
 *    notification service) is still safe — `BEGIN IMMEDIATE` takes the write
 *    lock for the whole transaction — but only if that writer is equally
 *    disciplined about transactions.
 */
import { NKinds } from "@nostrify/nostrify";

import { ParsedFilter } from "./ParsedFilter";
import { batch, memberOf, where } from "./sql";
import { ARMADA_DB_FTS_SCHEMA, ARMADA_DB_SCHEMA } from "./sqliteSchema";
import { defaultIndexTags, prefixUpperBound } from "./types";

import type { NostrFilter } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";
import type { ArmadaSqlDriver, SqlRow, SqlValue } from "./driver";
import type { TagFilter } from "./ParsedFilter";
import type { ArmadaDB, ArmadaDBOpts, ArmadaKV, NRumorStore } from "./types";

/**
 * How many candidate keys a paged scan fetches per round trip. Only scans that
 * need in-memory post-filtering (extra tag terms, NIP-50 keywords) page; a
 * scan that SQL fully satisfies reads exactly the rows it needs.
 */
const CHUNK_SIZE = 512;

/**
 * Upper bound on bound parameters per statement. SQLite's own limit is 32766
 * on modern builds but only 999 on older ones, and some drivers impose their
 * own, so statements are split well below the floor.
 */
const MAX_PARAMS = 900;

/** Upper bound on the rows one page of a scan may read, however large the limit. */
const MAX_PAGE = 10_000;

/** Longest `IN (…)` list driving a scan before it is split across statements. */
const MAX_IN = 500;

/**
 * Longest `IN (…)` list used to *filter* a scan. A longer one is matched in
 * memory instead, which keeps the statement's parameter count bounded.
 */
const MAX_PUSHDOWN = 100;

/**
 * Most ids a secondary tag term is materialized into before it's left to the
 * in-memory match instead.
 */
const MAX_TAG_SET = 100_000;

/**
 * How many full-text matches are worth driving a query with. A term matching
 * more than this is common enough that an ordinary indexed scan will run into
 * matches quickly, so it filters the scan instead of driving it.
 */
const MAX_SEARCH_IDS = 1_000;

/**
 * The share of rumors a keyword must match before the scan tests rows against
 * the index one at a time rather than collecting every match up front.
 */
const DENSE_SEARCH = 0.25;

export interface SqliteArmadaDBOpts extends ArmadaDBOpts {
  /**
   * Whether to install the schema on construction. Pass `false` when the
   * transport owns the file's schema (the Android service does). Default
   * `true`.
   */
  migrate?: boolean;
  /**
   * Whether to maintain the FTS5 index (@link ARMADA_DB_FTS_SCHEMA) that NIP-50
   * `search` filters are resolved against. Default `true`.
   *
   * Turning it off roughly halves the cost of a write, and leaves `search`
   * working but slow: keywords then post-filter an ordinary indexed scan in
   * memory, matching substrings rather than whole words. Must agree with what
   * was migrated — a store told `search: false` against a database that HAS
   * the triggers still indexes every write, it just never reads the index.
   */
  search?: boolean;
}

export class SqliteArmadaDB implements ArmadaDB {
  private readonly db: ArmadaSqlDriver;
  private readonly indexTags: (rumor: NostrRumor) => string[][];
  /** Whether the FTS5 index is maintained, and so usable by `search`. */
  private readonly search: boolean;
  private readonly stores = new Map<string, SqliteRumorStore>();

  /** Rumors queued by `event()`, awaiting the next batched commit. */
  private pending: PendingWrite[] = [];
  /** Whether a flush is already scheduled for the current burst. */
  private flushScheduled = false;
  /**
   * Tail of the write chain. Transactions queue behind it rather than
   * interleaving, since SQLite has no nested transactions and two overlapping
   * writers would otherwise share — and roll back — each other's work.
   */
  private writeLock: Promise<unknown> = Promise.resolve();

  /** Resolves once the schema is installed; every operation awaits it. */
  readonly ready: Promise<void>;
  readonly kv: ArmadaKV;

  constructor(db: ArmadaSqlDriver, opts: SqliteArmadaDBOpts = {}) {
    this.db = db;
    this.indexTags = opts.indexTags ?? defaultIndexTags;
    this.search = opts.search !== false;
    this.kv = new SqliteKV(this);

    this.ready = opts.migrate === false ? Promise.resolve() : this.migrate();
    // Marks the rejection handled; callers still see it, since every operation
    // awaits `ready` itself.
    this.ready.catch(() => {});
  }

  tenant(id: string): NRumorStore {
    let store = this.stores.get(id);
    if (!store) {
      store = new SqliteRumorStore(this, id);
      this.stores.set(id, store);
    }
    return store;
  }

  /**
   * Create the tables, indexes and triggers this adapter needs, if they don't
   * already exist. Run from the constructor unless `migrate: false`.
   */
  async migrate(): Promise<void> {
    const schema = this.search
      ? [...ARMADA_DB_SCHEMA, ...ARMADA_DB_FTS_SCHEMA]
      : ARMADA_DB_SCHEMA;

    for (const statement of schema) {
      await this.run(statement.trim().replace(/\s+/g, " "));
    }
  }

  /** Empty every table (logout purge). Keeps the schema. */
  async wipe(): Promise<void> {
    await this.ready;
    await this.transaction(async () => {
      await this.run(`DELETE FROM rumor_tags`);
      await this.run(`DELETE FROM rumor_coords`);
      await this.run(`DELETE FROM rumors`);
      await this.run(`DELETE FROM kv`);
    });
  }

  /** Close the underlying connection, if the driver has one to close. */
  async close(): Promise<void> {
    await this.db.close?.();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  // ── Write path ────────────────────────────────────────────────────────────

  /**
   * Queue a rumor for the next batched commit.
   *
   * A microtask is the tightest flush window that still catches a whole burst:
   * every `event()` call made before the caller next awaits lands in the same
   * transaction, and no latency is added for callers that don't batch.
   */
  putRumor(tenant: string, rumor: NostrRumor): Promise<void> {
    if (NKinds.ephemeral(rumor.kind)) return Promise.resolve();

    // `NostrRumor` has no `sig`, but a caller can hand over a full `NostrEvent`
    // structurally, and the row is `JSON.stringify(rumor)` — so a signature
    // would be persisted verbatim here while the IndexedDB adapter drops it.
    // Strip it so the two agree that the store holds rumors, nothing else.
    const { sig: _sig, ...stored } = rumor as NostrRumor & { sig?: string };

    return new Promise<void>((resolve, reject) => {
      this.pending.push({ tenant, rumor: stored, resolve, reject });
      this.scheduleFlush();
    });
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;

    queueMicrotask(() => {
      this.flushScheduled = false;
      void this.flushWrites();
    });
  }

  /** Commit every queued rumor in one transaction, then settle their callers. */
  private async flushWrites(): Promise<void> {
    const writes = this.pending;
    if (writes.length === 0) return;

    this.pending = [];

    try {
      await this.ready;
      await this.transaction(async () => {
        for (const { tenant, rumor } of writes) {
          await this.writeRumor(tenant, rumor);
        }
      });
    } catch (error) {
      for (const write of writes) write.reject(error);
      return;
    }

    // Settled only after the commit, so resolving means durable.
    for (const write of writes) write.resolve();
  }

  /** Apply a single rumor's writes. Runs inside the batch transaction. */
  private async writeRumor(tenant: string, rumor: NostrRumor): Promise<void> {
    if (NKinds.replaceable(rumor.kind) || NKinds.addressable(rumor.kind)) {
      const coord = getCoord(rumor);

      const [existing] = await this.all(
        `SELECT id, created_at FROM rumor_coords WHERE tenant = ? AND coord = ?`,
        [tenant, coord],
      );

      if (existing) {
        const stored = { id: String(existing.id), created_at: Number(existing.created_at) };
        // Per NIP-01 the stored version wins ties, and an identical id is a
        // no-op, so only a strictly newer rumor replaces it.
        if (!isNewer(rumor, stored)) return;
        await this.deleteRumors(tenant, [stored.id]);
      }

      await this.insertRumor(tenant, rumor);

      await this.run(
        `INSERT OR REPLACE INTO rumor_coords (tenant, coord, id, created_at) VALUES (?, ?, ?, ?)`,
        [tenant, coord, rumor.id, rumor.created_at],
      );
    } else {
      await this.insertRumor(tenant, rumor);
    }

    // Applied after the insert so a kind 5 arriving alongside its targets in
    // one batch still resolves. The request itself is retained.
    if (rumor.kind === 5) {
      await this.applyDeletion(tenant, rumor);
    }
  }

  /** Write the rumor row and its tag index rows. */
  private async insertRumor(tenant: string, rumor: NostrRumor): Promise<void> {
    // `OR IGNORE` makes a re-delivered rumor a no-op rather than an error.
    await this.run(
      `INSERT OR IGNORE INTO rumors (tenant, id, kind, pubkey, created_at, json)
        VALUES (?, ?, ?, ?, ?, ?)`,
      [tenant, rumor.id, rumor.kind, rumor.pubkey, rumor.created_at, JSON.stringify(rumor)],
    );

    const rows = this.tagRows(tenant, rumor);
    if (rows.length === 0) return;

    // 6 columns per row; batch as many as the parameter budget allows.
    const perStatement = Math.floor(MAX_PARAMS / 6);

    for (const chunk of batch(rows, perStatement)) {
      const values = chunk.map(() => "(?, ?, ?, ?, ?, ?)").join(", ");
      await this.run(
        `INSERT OR IGNORE INTO rumor_tags (tenant, name, value, created_at, id, kind)
          VALUES ${values}`,
        chunk.flat(),
      );
    }
  }

  /**
   * The tag index rows for a rumor: one per distinct `(name, value)` pair the
   * `indexTags` policy selects.
   */
  private tagRows(tenant: string, rumor: NostrRumor): SqlValue[][] {
    const rows: SqlValue[][] = [];
    const seen = new Set<string>();

    for (const [name, value] of this.indexTags(rumor)) {
      if (typeof name !== "string" || typeof value !== "string") continue;
      // The NUL separator can't appear in either part, so distinct pairs never
      // collide in the dedupe set.
      const key = `${name}\u0000${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push([tenant, name, value, rumor.created_at, rumor.id, rumor.kind]);
    }

    return rows;
  }

  /**
   * NIP-09: delete the rumors a kind 5 request targets, within its tenant.
   *
   * A request can only delete its author's own rumors, so every target is
   * checked against the request's `pubkey`. `a` tags additionally only delete
   * versions at or before the request's `created_at`, so a newer replacement
   * survives.
   */
  private async applyDeletion(tenant: string, request: NostrRumor): Promise<void> {
    const targets = request.tags.filter(
      ([name, value]) => (name === "e" || name === "a") && !!value,
    );
    if (targets.length === 0) return;

    const ids = new Set<string>();

    const eTags = targets.filter(([name]) => name === "e").map(([, value]) => value);
    const aTags = targets.filter(([name]) => name === "a").map(([, value]) => value);

    for (const chunk of batch(eTags, MAX_PARAMS - 2)) {
      const rows = await this.all(
        `SELECT id FROM rumors WHERE tenant = ? AND ${memberOf("id", chunk)} AND pubkey = ?`,
        [tenant, ...chunk, request.pubkey],
      );
      for (const row of rows) ids.add(String(row.id));
    }

    // Only one version of a coordinate is ever stored, so an `a` tag resolves
    // to at most one rumor via a primary-key lookup.
    const owned = aTags.filter((coord) => coord.split(":")[1] === request.pubkey);

    for (const chunk of batch(owned, MAX_PARAMS - 2)) {
      const rows = await this.all(
        `SELECT id FROM rumor_coords
          WHERE tenant = ? AND ${memberOf("coord", chunk)} AND created_at <= ?`,
        [tenant, ...chunk, request.created_at],
      );
      for (const row of rows) ids.add(String(row.id));
    }

    // The request can't delete itself.
    ids.delete(request.id);

    await this.deleteRumors(tenant, [...ids]);
  }

  /**
   * Delete rumors by id, along with their tag index rows and any coordinate
   * they occupy.
   *
   * Tag rows are removed by exact primary key, recomputed from the stored
   * rumor, so the tag index needs no secondary index on `id` — which would
   * otherwise cost a b-tree insert per tag on every write.
   */
  private async deleteRumors(tenant: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;

    const rumors: NostrRumor[] = [];
    for (const chunk of batch(ids, MAX_PARAMS - 1)) {
      const rows = await this.all(
        `SELECT json FROM rumors WHERE tenant = ? AND ${memberOf("id", chunk)}`,
        [tenant, ...chunk],
      );
      for (const row of rows) rumors.push(JSON.parse(String(row.json)));
    }
    if (rumors.length === 0) return;

    // Deleted one row at a time, by full primary key, so each is a seek into
    // the tag b-tree. A tuple `IN (VALUES …)` would be one statement but would
    // scan the table.
    for (const rumor of rumors) {
      for (const [, name, value, created_at] of this.tagRows(tenant, rumor)) {
        await this.run(
          `DELETE FROM rumor_tags
            WHERE tenant = ? AND name = ? AND value = ? AND created_at = ? AND id = ?`,
          [tenant, name, value, created_at, rumor.id],
        );
      }
    }

    const coords = rumors
      .filter((rumor) => NKinds.replaceable(rumor.kind) || NKinds.addressable(rumor.kind))
      .map((rumor) => getCoord(rumor));

    for (const chunk of batch(coords, MAX_PARAMS - 1)) {
      await this.run(
        `DELETE FROM rumor_coords WHERE tenant = ? AND ${memberOf("coord", chunk)}`,
        [tenant, ...chunk],
      );
    }

    for (const chunk of batch(rumors.map((rumor) => rumor.id), MAX_PARAMS - 1)) {
      await this.run(
        `DELETE FROM rumors WHERE tenant = ? AND ${memberOf("id", chunk)}`,
        [tenant, ...chunk],
      );
    }
  }

  // ── Read path ─────────────────────────────────────────────────────────────

  /**
   * Rumors in `tenant` matching the filters (OR'd together), newest-first,
   * de-duplicated by id, each filter's `limit` respected.
   */
  async queryTenant(
    tenant: string,
    filters: NostrFilter[],
    opts?: { signal?: AbortSignal },
  ): Promise<NostrRumor[]> {
    await this.ready;

    const byId = new Map<string, NostrRumor>();

    // Run sequentially: the driver holds a single connection, so concurrency
    // would buy nothing and could interleave badly.
    for (const filter of filters) {
      for (const rumor of await this.queryFilter(tenant, new ParsedFilter(filter), opts?.signal)) {
        byId.set(rumor.id, rumor);
      }
    }

    return [...byId.values()].sort(compareNewest);
  }

  /**
   * Run a single parsed filter through the planner cascade, returning matching
   * rumors newest-first up to the filter's limit.
   */
  private async queryFilter(
    tenant: string,
    filter: ParsedFilter,
    signal?: AbortSignal,
  ): Promise<NostrRumor[]> {
    if (filter.neverMatch) return [];

    const limit = filter.limit ?? Infinity;
    if (limit <= 0) return [];

    signal?.throwIfAborted();

    const search = await this.resolveSearch(filter);
    if (search?.rowids?.length === 0) return [];

    const plan = this.planScan(tenant, filter, search);
    // FTS5 has applied the keywords already wherever the plan carries them.
    const searched = plan.searchInSql;

    // ids plans are primary-key lookups. Everything the rumors table can
    // express goes into the query, so that when it expresses the whole filter
    // the ordering and limit go in too — a selective search can resolve to
    // thousands of ids, and deserializing all of them to return twenty would
    // undo what the index just saved.
    const keys: (string | number)[] | undefined = plan.ids ?? plan.rowids;

    if (keys) {
      const column = plan.ids ? "id" : "rowid";
      const pushKinds = !filter.kinds || filter.kinds.length <= MAX_PUSHDOWN;
      const pushAuthors = !filter.authors || filter.authors.length <= MAX_PUSHDOWN;
      const complete = filter.tags.length === 0 && pushKinds && pushAuthors &&
        (searched || !filter.searchKeywords);

      const rumors: NostrRumor[] = [];

      // Each part gets the full limit, so the merged result still holds the
      // newest `limit` overall.
      for (const chunk of batch(keys, MAX_PARAMS - 16)) {
        const conditions = ["tenant = ?", memberOf(column, chunk)];
        const params: SqlValue[] = [tenant, ...chunk];

        if (filter.since !== undefined) {
          conditions.push("created_at >= ?");
          params.push(filter.since);
        }
        if (filter.until !== undefined) {
          conditions.push("created_at <= ?");
          params.push(filter.until);
        }
        if (filter.kinds && pushKinds) {
          conditions.push(memberOf("kind", filter.kinds));
          params.push(...filter.kinds);
        }
        if (filter.authors && pushAuthors) {
          conditions.push(memberOf("pubkey", filter.authors));
          params.push(...filter.authors);
        }

        let sql = `SELECT json FROM rumors${where(conditions)}`;

        if (complete && limit !== Infinity) {
          sql += " ORDER BY created_at DESC, id ASC LIMIT ?";
          params.push(limit);
        }

        for (const row of await this.all(sql, params)) {
          const rumor: NostrRumor = JSON.parse(String(row.json));
          if (complete || filter.matches(rumor, searched)) rumors.push(rumor);
        }
      }

      rumors.sort(compareNewest);
      return rumors.length > limit ? rumors.slice(0, limit) : rumors;
    }

    // A single cursor that SQL fully satisfies needs no candidate phase: the
    // rows the index scan yields are exactly the answer, so read their bodies
    // straight from the covering scan instead of paying a second key lookup.
    if (plan.sqlOnly && plan.cursors.length === 1 && plan.cursors[0].source === "rumors") {
      const [cursor] = plan.cursors;
      const params = [...cursor.params];
      let sql = `SELECT json FROM ${cursor.from}${
        where(cursor.where)
      } ORDER BY created_at DESC, id ASC`;

      if (limit !== Infinity) {
        sql += " LIMIT ?";
        params.push(limit);
      }

      const rows = await this.all(sql, params);
      return rows.map((row) => JSON.parse(String(row.json)));
    }

    // Everything else: scan the index for candidate keys, fetch their values,
    // and (when SQL couldn't express the whole filter) match in memory, paging
    // by keyset until the limit is met or the scan is exhausted.
    const collected: NostrRumor[] = [];
    const seen = new Set<string>();
    // When SQL expresses the whole filter, a page is the answer, so read the
    // limit in one go; otherwise page in chunks so post-filtering a scan that
    // matches little doesn't materialize the whole range.
    const pageSize = plan.sqlOnly && limit !== Infinity ? Math.min(limit, MAX_PAGE) : CHUNK_SIZE;

    // A single scan over `rumors` can read the bodies as it goes: the
    // candidates are exactly the rows wanted, so a second lookup by id would
    // re-seek rows the scan already visited. Splitting the phases still pays
    // off for tag scans (the bodies live in another table) and for split scans
    // (where each part over-reads by up to a page).
    const inline = plan.cursors.length === 1 && plan.cursors[0].source === "rumors";

    // Tag terms the scan doesn't drive on, resolved to id sets so candidates
    // failing them are dropped before their bodies are ever read.
    const tagSets = await this.tagIdSets(tenant, plan, filter);

    // Each set is a necessary condition, so a candidate must appear in all of
    // them. Collapsing them up front turns the per-candidate check into one
    // lookup, and an empty intersection settles the whole filter.
    let required: Set<string> | undefined;

    if (tagSets.length > 0) {
      required = tagSets[0];
      for (const set of tagSets.slice(1)) {
        required = new Set([...required].filter((id) => set.has(id)));
      }
      if (required.size === 0) return [];
    }

    let after: Keyset | undefined;

    while (collected.length < limit) {
      signal?.throwIfAborted();

      const page = await this.scanCandidates(plan, after, pageSize, inline);
      if (page.length === 0) break;

      after = page[page.length - 1];

      const candidates = required ? page.filter(({ id }) => required.has(id)) : page;

      const values = inline || candidates.length === 0
        ? undefined
        : await this.fetchRumors(tenant, candidates.map(({ id }) => id));

      for (const candidate of candidates) {
        if (collected.length >= limit) break;
        if (seen.has(candidate.id)) continue;
        seen.add(candidate.id);

        const rumor = candidate.rumor ?? values?.get(candidate.id);
        // A tag row can outlive its rumor if the `indexTags` policy changed
        // between the write and the delete; treat the key as a miss.
        if (!rumor) continue;

        if (plan.sqlOnly || filter.matches(rumor, searched)) collected.push(rumor);
      }

      // A short page means the scan is exhausted.
      if (page.length < pageSize) break;
    }

    // Already newest-first, but merged pages can interleave `created_at` ties.
    collected.sort(compareNewest);
    return collected;
  }

  /**
   * Read one page of candidate keys, newest-first.
   *
   * Each cursor contributes a `LIMIT`-ed subquery over its own index range, so
   * the page costs ~`pageSize` rows per cursor rather than every row in range.
   * The scans are covering, so no rumor bodies are read here unless `inline`.
   */
  private async scanCandidates(
    plan: ScanPlan,
    after: Keyset | undefined,
    pageSize: number,
    inline: boolean,
  ): Promise<Keyset[]> {
    const merged: Keyset[] = [];

    for (const cursor of plan.cursors) {
      const conditions = [...cursor.where];
      const params = [...cursor.params];

      if (after) {
        // Resume strictly after the last key of the previous page. The
        // `created_at <= ?` term drives the index seek; the disjunction only
        // breaks ties, and guarantees progress when a whole page shares one
        // timestamp.
        conditions.push("created_at <= ?", "(created_at < ? OR id > ?)");
        params.push(after.created_at, after.created_at, after.id);
      }

      params.push(pageSize);

      const rows = await this.all(
        `SELECT ${cursor.distinct ? "DISTINCT " : ""}created_at, id${
          inline ? ", json" : ""
        } FROM ${cursor.from}${where(conditions)} ORDER BY created_at DESC, id ASC LIMIT ?`,
        params,
      );

      for (const row of rows) {
        merged.push({
          created_at: Number(row.created_at),
          id: String(row.id),
          rumor: inline ? JSON.parse(String(row.json)) : undefined,
        });
      }
    }

    if (plan.cursors.length === 1) return merged;

    merged.sort(compareKeyset);
    return merged.slice(0, pageSize);
  }

  /**
   * Resolve the plan's non-driving tag terms to sets of matching rumor ids.
   *
   * A filter like `{"#channel": [...], "#p": [...]}` can only be driven by one
   * tag index. Reading each remaining term's ids — a covering scan of the tag
   * index, no rumor bodies — turns the rest of the intersection into a Set
   * lookup, so candidates that fail are discarded before anything is
   * deserialized.
   */
  private async tagIdSets(
    tenant: string,
    plan: ScanPlan,
    filter: ParsedFilter,
  ): Promise<Set<string>[]> {
    if (!plan.extraTags?.length) return [];

    const sets: Set<string>[] = [];

    for (const tag of plan.extraTags) {
      const ids = new Set<string>();
      let overflowed = false;

      for (const values of batch(tag.values, MAX_IN)) {
        const conditions = ["tenant = ?", "name = ?", memberOf("value", values)];
        const params: SqlValue[] = [tenant, tag.name, ...values];

        // The time bounds apply to every term, so they narrow this set too.
        if (filter.since !== undefined) {
          conditions.push("created_at >= ?");
          params.push(filter.since);
        }
        if (filter.until !== undefined) {
          conditions.push("created_at <= ?");
          params.push(filter.until);
        }

        params.push(MAX_TAG_SET + 1);

        const rows = await this.all(
          `SELECT id FROM rumor_tags${where(conditions)} LIMIT ?`,
          params,
        );

        for (const row of rows) ids.add(String(row.id));

        if (ids.size > MAX_TAG_SET) {
          overflowed = true;
          break;
        }
      }

      if (!overflowed) sets.push(ids);
    }

    return sets;
  }

  /**
   * Resolve a filter's NIP-50 keywords against the full-text index.
   *
   * A selective term should *drive* the query: scanning `created_at` and
   * testing each row would walk most of the store to find twenty matches. A
   * common term should not: matches are dense enough that an ordinary indexed
   * scan finds a page of them almost immediately, whereas driving from the
   * index means fetching and sorting every hit.
   *
   * So the index is probed for one more id than is worth driving with. Coming
   * back under that bound settles it — those ids are the whole match set.
   * Going over means the term is common, and the probe stops early.
   *
   * The probe spans tenants (the FTS index has no tenant column); the tenant
   * filter is applied when the matches are resolved back to rows, so the
   * result is the same either way.
   */
  private async resolveSearch(filter: ParsedFilter): Promise<SearchPlan | undefined> {
    // Without the index there is nothing to resolve against: the keywords fall
    // through to the in-memory match, which post-filters an ordinary scan.
    if (!this.search || !filter.searchQuery) return undefined;

    // Probed against the index alone. Reaching through the rumors table here
    // would defeat the `LIMIT`: SQLite materializes a `rowid IN (subquery)` in
    // full before limiting it, so a common term would cost every one of its
    // matches just to discover there are too many. FTS5 streams its own
    // results, so this stops as soon as the bound is passed.
    const probe = await this.all(
      `SELECT rowid FROM rumors_fts WHERE rumors_fts MATCH ? LIMIT ?`,
      [filter.searchQuery, MAX_SEARCH_IDS + 1],
    );

    if (probe.length > MAX_SEARCH_IDS) {
      // Too many to drive with, so the keywords filter a scan instead — and
      // which filter is cheaper depends on how thickly the matches are spread.
      // FTS5 returns matches in rowid order, so how far the probe had to reach
      // to collect its bound estimates that.
      const first = Number(probe[0].rowid);
      const last = Number(probe[probe.length - 1].rowid);
      const density = probe.length / Math.max(1, last - first + 1);

      return { match: filter.searchQuery, dense: density >= DENSE_SEARCH };
    }

    // Kept as rowids. Translating them to rumor ids would mean handing every
    // match across the driver just to look it up again by another key.
    return { rowids: probe.map((row) => Number(row.rowid)) };
  }

  /** Fetch rumor bodies by id. */
  private async fetchRumors(tenant: string, ids: string[]): Promise<Map<string, NostrRumor>> {
    const rumors = new Map<string, NostrRumor>();

    for (const chunk of batch([...new Set(ids)], MAX_PARAMS - 1)) {
      const rows = await this.all(
        `SELECT json FROM rumors WHERE tenant = ? AND ${memberOf("id", chunk)}`,
        [tenant, ...chunk],
      );
      for (const row of rows) {
        const rumor: NostrRumor = JSON.parse(String(row.json));
        rumors.set(rumor.id, rumor);
      }
    }

    return rumors;
  }

  /**
   * The query planner — a port of strfry's `DBScan` constructor. Picks exactly
   * one index by a fixed priority cascade and forces it with `INDEXED BY`, so
   * the plan never depends on SQLite's cost estimates. Whatever else the
   * filter asks for is pushed into the scan's `WHERE` clause when the chosen
   * index can carry it.
   */
  private planScan(tenant: string, filter: ParsedFilter, search?: SearchPlan): ScanPlan {
    /**
     * Apply the FTS5 match to a scan over the rumors table. Only reachable for
     * a common term — a selective one drives the query as a rowid list instead
     * — and only on the rumors table, since the tag index has no rowid to
     * reach the full-text index by.
     */
    const addSearch = (
      source: ScanCursor["source"],
      conditions: string[],
      params: SqlValue[],
    ): void => {
      if (source !== "rumors" || !search?.match) return;

      // A dense term is tested row by row, which costs only the handful of
      // rows the scan reads before it has enough matches. A sparse one is
      // collected up front instead, since testing rows individually would mean
      // reading far too many of them to find anything.
      conditions.push(
        search.dense
          ? `EXISTS (SELECT 1 FROM rumors_fts WHERE rumors_fts.rowid = rumors.rowid AND rumors_fts MATCH ?)`
          : `rumors.rowid IN (SELECT rowid FROM rumors_fts WHERE rumors_fts MATCH ?)`,
      );
      params.push(search.match);
    };

    // Whether the filter's keywords end up applied by the query rather than in
    // memory. A rowid set settles them for any plan; a match expression only
    // works on the rumors table, so a tag-driven scan still has to check them
    // itself. A rowid set can only drive the query when nothing else is: an
    // `ids` filter is already a lookup, and combining two key lists in one
    // statement isn't worth the chunking it would need.
    const searchInIds = !filter.searchKeywords || (!!search?.rowids && !filter.ids);
    const searchInSql = searchInIds || !!search?.match;

    /** Append the filter's `since`/`until` bounds to a cursor. */
    const addTime = (conditions: string[], params: SqlValue[]): void => {
      if (filter.since !== undefined) {
        conditions.push("created_at >= ?");
        params.push(filter.since);
      }
      if (filter.until !== undefined) {
        conditions.push("created_at <= ?");
        params.push(filter.until);
      }
    };

    /** Whether a value list is short enough to filter a scan with. */
    const pushable = (values: unknown[] | undefined): boolean =>
      !!values && values.length <= MAX_PUSHDOWN;

    // 1. ids — the (tenant, id) unique index. Fetched directly, no index scan.
    //    A selective search resolves to a rowid set, the same kind of lookup.
    if (filter.ids) {
      return { ids: filter.ids, cursors: [], sqlOnly: false, searchInSql: searchInIds };
    }
    if (search?.rowids) {
      return { rowids: search.rowids, cursors: [], sqlOnly: false, searchInSql: searchInIds };
    }

    // 2. tags — the most selective tag filter (fewest values). A rumor
    //    carrying several of the sought values matches once per value, hence
    //    the DISTINCT.
    if (filter.tags.length > 0) {
      const tag = filter.tags.reduce((a, b) => (b.values.length < a.values.length ? b : a));
      // `kind` is denormalized onto the tag index, so kinds can filter the
      // scan; authors fall to the in-memory match. The remaining tag terms are
      // intersected against the scan by id — see `tagIdSets`.
      const pushKinds = pushable(filter.kinds);
      const extraTags = filter.tags.filter((other) => other !== tag);

      const cursors = [...batch(tag.values, MAX_IN)].map((values): ScanCursor => {
        const conditions = ["tenant = ?", "name = ?", memberOf("value", values)];
        const params: SqlValue[] = [tenant, tag.name, ...values];

        addTime(conditions, params);

        if (pushKinds) {
          conditions.push(memberOf("kind", filter.kinds!));
          params.push(...filter.kinds!);
        }

        return {
          source: "tags",
          from: "rumor_tags",
          where: conditions,
          params,
          distinct: values.length > 1,
        };
      });

      return {
        cursors,
        extraTags,
        // The tag index has no rowid to reach the full-text index by, so
        // keywords on a tag-driven scan are still matched in memory.
        searchInSql: searchInIds,
        sqlOnly: !filter.searchKeywords && !filter.authors && filter.tags.length === 1 &&
          (!filter.kinds || pushKinds),
      };
    }

    // 3. authors + kinds. SQLite seeks the index once per combination, so this
    //    is only worth it while the combinatorial product stays small; beyond
    //    that, scanning by author alone and filtering on kind is cheaper.
    if (
      filter.authors && filter.kinds && pushable(filter.kinds) &&
      filter.authors.length * filter.kinds.length < 1000
    ) {
      const cursors = [...batch(filter.authors, MAX_IN)].map((authors): ScanCursor => {
        const conditions = ["tenant = ?", memberOf("pubkey", authors), memberOf("kind", filter.kinds!)];
        const params: SqlValue[] = [tenant, ...authors, ...filter.kinds!];

        addTime(conditions, params);
        addSearch("rumors", conditions, params);

        return {
          source: "rumors",
          from: "rumors INDEXED BY rumors_pubkey_kind",
          where: conditions,
          params,
        };
      });

      return { cursors, searchInSql, sqlOnly: searchInSql };
    }

    // 4. authors. When kinds is also present it filters the scan instead of
    //    driving it.
    if (filter.authors) {
      const pushKinds = pushable(filter.kinds);

      const cursors = [...batch(filter.authors, MAX_IN)].map((authors): ScanCursor => {
        const conditions = ["tenant = ?", memberOf("pubkey", authors)];
        const params: SqlValue[] = [tenant, ...authors];

        addTime(conditions, params);

        if (pushKinds) {
          conditions.push(memberOf("kind", filter.kinds!));
          params.push(...filter.kinds!);
        }

        addSearch("rumors", conditions, params);

        return {
          source: "rumors",
          from: "rumors INDEXED BY rumors_pubkey",
          where: conditions,
          params,
        };
      });

      return { cursors, searchInSql, sqlOnly: searchInSql && (!filter.kinds || pushKinds) };
    }

    // 5. kinds.
    if (filter.kinds) {
      const cursors = [...batch(filter.kinds, MAX_IN)].map((kinds): ScanCursor => {
        const conditions = ["tenant = ?", memberOf("kind", kinds)];
        const params: SqlValue[] = [tenant, ...kinds];

        addTime(conditions, params);
        addSearch("rumors", conditions, params);

        return {
          source: "rumors",
          from: "rumors INDEXED BY rumors_kind",
          where: conditions,
          params,
        };
      });

      return { cursors, searchInSql, sqlOnly: searchInSql };
    }

    // 6. fallback — the whole tenant, newest-first.
    const conditions = ["tenant = ?"];
    const params: SqlValue[] = [tenant];
    addTime(conditions, params);
    addSearch("rumors", conditions, params);

    return {
      cursors: [{
        source: "rumors",
        from: "rumors INDEXED BY rumors_created_at",
        where: conditions,
        params,
      }],
      searchInSql,
      sqlOnly: searchInSql,
    };
  }

  /** How many rumors in `tenant` match. */
  async countTenant(
    tenant: string,
    filters: NostrFilter[],
    opts?: { signal?: AbortSignal },
  ): Promise<{ count: number; approximate: boolean }> {
    await this.ready;

    // Fast path: a single unlimited filter that one scan expresses completely
    // is counted inside the index, with no rows returned and no rumor bodies
    // read. (ids plans are excluded — they're key lookups, not scans. So are
    // split scans, whose parts could both see the same rumor.)
    if (filters.length === 1) {
      const filter = new ParsedFilter(filters[0]);
      if (filter.neverMatch) return { count: 0, approximate: false };

      if (filter.limit === undefined) {
        const search = await this.resolveSearch(filter);
        if (search?.rowids?.length === 0) return { count: 0, approximate: false };

        const plan = this.planScan(tenant, filter, search);

        if (plan.sqlOnly && !plan.ids && !plan.rowids && plan.cursors.length === 1) {
          const [cursor] = plan.cursors;

          const [row] = await this.all(
            `SELECT COUNT(*) AS count FROM (SELECT ${
              cursor.distinct ? "DISTINCT " : ""
            }created_at, id FROM ${cursor.from}${where(cursor.where)})`,
            cursor.params,
          );

          return { count: Number(row?.count ?? 0), approximate: false };
        }
      }
    }

    const rumors = await this.queryTenant(tenant, filters, opts);
    return { count: rumors.length, approximate: false };
  }

  /** Remove every rumor in `tenant` matching the filters. */
  async removeTenant(
    tenant: string,
    filters: NostrFilter[],
    opts?: { signal?: AbortSignal },
  ): Promise<void> {
    const rumors = await this.queryTenant(tenant, filters, opts);
    if (rumors.length === 0) return;

    await this.transaction(() => this.deleteRumors(tenant, rumors.map((rumor) => rumor.id)));
  }

  // ── Driver plumbing ───────────────────────────────────────────────────────

  /** Run a statement that returns no rows. */
  async run(sql: string, params: SqlValue[] = []): Promise<void> {
    await this.db.run(sql, params);
  }

  /** Run a statement and return its rows. */
  async all(sql: string, params: SqlValue[] = []): Promise<SqlRow[]> {
    return await this.db.all(sql, params);
  }

  /**
   * Run `fn` inside a transaction, queued behind any transaction already in
   * flight. Serializing them keeps a write that starts mid-flush from being
   * swept into that flush's transaction and rolled back with it.
   */
  transaction<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.writeLock.then(async () => {
      await this.run("BEGIN IMMEDIATE");

      try {
        const value = await fn();
        await this.run("COMMIT");
        return value;
      } catch (error) {
        await this.run("ROLLBACK");
        throw error;
      }
    });

    // The chain must not break on failure, so successors wait on a settled
    // promise rather than a rejected one.
    this.writeLock = result.catch(() => {});

    return result;
  }

  [Symbol.toStringTag] = "SqliteArmadaDB";
}

/** The per-tenant façade. All the work happens on the shared connection. */
class SqliteRumorStore implements NRumorStore {
  constructor(
    private readonly db: SqliteArmadaDB,
    private readonly id: string,
  ) {}

  event(event: NostrRumor, _opts?: { signal?: AbortSignal }): Promise<void> {
    return this.db.putRumor(this.id, event);
  }

  query(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<NostrRumor[]> {
    return this.db.queryTenant(this.id, filters, opts);
  }

  count(
    filters: NostrFilter[],
    opts?: { signal?: AbortSignal },
  ): Promise<{ count: number; approximate: boolean }> {
    return this.db.countTenant(this.id, filters, opts);
  }

  remove(filters: NostrFilter[], opts?: { signal?: AbortSignal }): Promise<void> {
    return this.db.removeTenant(this.id, filters, opts);
  }

  [Symbol.toStringTag] = "SqliteRumorStore";
}

/** The KV table: JSON text by key, written through the same write lock. */
class SqliteKV implements ArmadaKV {
  constructor(private readonly db: SqliteArmadaDB) {}

  async get<T>(key: string): Promise<T | undefined> {
    await this.db.ready;
    const [row] = await this.db.all(`SELECT value FROM kv WHERE key = ?`, [key]);
    if (typeof row?.value !== "string") return undefined;
    return JSON.parse(row.value) as T;
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.db.ready;
    // `undefined` (and anything else without a JSON form) is out of contract;
    // normalized to null so both adapters agree instead of throwing here.
    const json = JSON.stringify(value) ?? "null";
    await this.db.transaction(() =>
      this.db.run(
        `INSERT INTO kv (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [key, json],
      )
    );
  }

  async delete(key: string): Promise<void> {
    await this.db.ready;
    await this.db.transaction(() => this.db.run(`DELETE FROM kv WHERE key = ?`, [key]));
  }

  async keys(prefix?: string): Promise<string[]> {
    await this.db.ready;

    let rows: SqlRow[];
    if (!prefix) {
      rows = await this.db.all(`SELECT key FROM kv ORDER BY key`);
    } else {
      const upper = prefixUpperBound(prefix);
      rows = upper === undefined
        ? await this.db.all(`SELECT key FROM kv WHERE key >= ? ORDER BY key`, [prefix])
        : await this.db.all(
          `SELECT key FROM kv WHERE key >= ? AND key < ? ORDER BY key`,
          [prefix, upper],
        );
    }

    const keys = rows.map((row) => String(row.key));
    // The range is a scan hint, not the contract — see `prefixUpperBound`.
    return prefix ? keys.filter((key) => key.startsWith(prefix)) : keys;
  }
}

/** The `kind:pubkey:d` coordinate of a replaceable or addressable rumor. */
function getCoord(rumor: NostrRumor): string {
  const d = NKinds.addressable(rumor.kind)
    ? rumor.tags.find(([name]) => name === "d")?.[1] ?? ""
    : "";
  return `${rumor.kind}:${rumor.pubkey}:${d}`;
}

/**
 * Per NIP-01, `a` is "newer" than `b` (same coordinate) when its created_at is
 * greater, or — on a tie — its id is lexicographically smaller.
 */
function isNewer(
  a: { id: string; created_at: number },
  b: { id: string; created_at: number },
): boolean {
  if (a.created_at > b.created_at) return true;
  if (a.created_at < b.created_at) return false;
  return a.id < b.id;
}

/** Newest-first; ties broken by smaller id first (NIP-01). */
function compareNewest(a: NostrRumor, b: NostrRumor): number {
  if (a.created_at !== b.created_at) return b.created_at - a.created_at;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The same ordering, over bare candidate keys. */
function compareKeyset(a: Keyset, b: Keyset): number {
  if (a.created_at !== b.created_at) return b.created_at - a.created_at;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** A rumor queued for the next batched commit, with its caller's settlers. */
interface PendingWrite {
  tenant: string;
  rumor: NostrRumor;
  resolve(): void;
  reject(error: unknown): void;
}

/** A candidate key produced by an index scan, and the keyset paging position. */
interface Keyset {
  created_at: number;
  id: string;
  /** The rumor body, when the scan read it inline rather than by a later lookup. */
  rumor?: NostrRumor;
}

/** One scan: a table (with a forced index) plus its conditions. */
interface ScanCursor {
  /** Which b-tree the scan reads, which decides what can be filtered on it. */
  source: "rumors" | "tags";
  /** The `FROM` clause, including any `INDEXED BY`. */
  from: string;
  where: string[];
  params: SqlValue[];
  /** Whether the scan can yield the same rumor more than once. */
  distinct?: boolean;
}

/** A planned scan: how to fetch a single filter's candidate rumors. */
interface ScanPlan {
  /** For ids plans: fetch these keys directly instead of scanning. */
  ids?: string[];
  /** The same, for a search selective enough to be resolved to rowids. */
  rowids?: number[];
  /**
   * Normally one scan. A filter whose driving value list is too long for a
   * single statement is split into several, merged by the caller.
   */
  cursors: ScanCursor[];
  /**
   * Tag terms the scan doesn't drive on. Each is resolved to a set of ids and
   * intersected with the candidates, so a candidate failing one never has its
   * body read.
   */
  extraTags?: TagFilter[];
  /**
   * Whether the scans' `WHERE` clauses express the filter completely, so
   * candidates need no in-memory re-check and the scan needs no paging.
   */
  sqlOnly: boolean;
  /** Whether the plan applies the filter's NIP-50 keywords itself. */
  searchInSql: boolean;
}

/**
 * How a filter's NIP-50 keywords will be applied: as the rowids they match,
 * when selective enough to drive the query, or as a match expression filtering
 * the scan when they aren't.
 */
interface SearchPlan {
  /** The rowids the keywords match, when few enough to drive the query. */
  rowids?: number[];
  match?: string;
  /** Whether the keywords match a large enough share of rumors to test row by row. */
  dense?: boolean;
}
