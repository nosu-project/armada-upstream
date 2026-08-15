/**
 * The SQLite adapter for {@link ArmadaDB} — a port of Nostrify's `NSQLiteFTS`,
 * with a `tenant` dimension threaded through every table and every index term.
 * See sqliteSchema.ts for the layout and for why the tag index is an FTS5
 * inverted index rather than a b-tree.
 *
 * One connection, one database: every tenant shares the `rumors` /
 * `rumor_tags_fts` / `rumor_coords` tables, and the KV store is a fourth.
 *
 * Two things carry the whole design:
 *
 *  - **`seq`, the rowid, encodes time** (`created_at × 2²⁰ + n`). So `ORDER BY
 *    seq DESC` is `ORDER BY created_at DESC` for the table, for every b-tree
 *    index over it, and — the point of the exercise — for FTS5, which only
 *    ever yields rows in rowid order. `since`/`until` become a rowid range
 *    that FTS5 pushes down into its own backwards walk of the posting lists.
 *  - **Tags are tokens.** A filter's tag terms, and its authors when a tag is
 *    already driving, become one MATCH expression: groups of alternatives,
 *    ANDed. FTS5 merges the groups' posting lists in C, so the cost is the
 *    length of the shortest group rather than the product of them all, and one
 *    rumor is one row of the index however many of its tags matched.
 *
 * Everything the index doesn't carry — kinds, and authors without a tag — is
 * tested on the `rumors` rows it finds, which costs a column read on a row
 * that was going to be fetched anyway. Filters naming no tag and no keyword
 * are driven by a b-tree instead, chosen by strfry's priority cascade:
 *
 *   ids → tags/search → pubkey+kind → pubkey → kind → the whole tenant
 *
 * Measured against the b-tree design this replaces (20k rumors, 3 tenants,
 * node:sqlite): tag queries 1.5–5× faster, NIP-50 search 5× faster, and the
 * b-tree plans unchanged within noise. Writes are the other side of the trade
 * — a rumor with three indexed tags costs ~1.4× more, because the write needs
 * a third statement to allocate its rowid, while a rumor with thirty costs
 * ~1.25× LESS, because a rumor is one index row here whatever its tag count
 * and was one b-tree insert per tag before. The two cross at about fifteen
 * tags.
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
 * Deliberate divergences from `NSQLiteFTS`:
 *
 *  - No deletion tombstone check on write, and so no `_d:`/`_c:` tokens.
 *    NSQLiteFTS refuses to re-admit an event a stored kind 5 already deleted;
 *    `NIndexedDB` (and so the IndexedDB adapter) has no such check, and the
 *    adapters have to agree.
 *  - Results are always re-sorted by `(created_at DESC, id ASC)` rather than
 *    returned in `seq` order, since that ordering is part of ArmadaDB's
 *    contract. Note the one place the two adapters can still disagree: WHICH
 *    of several rumors sharing a `created_at` survives a `limit` that cuts
 *    through them, since the scan takes the newest by `seq` (insertion order)
 *    and only then sorts.
 *  - A rumor is stored as its six NIP-01 fields, one column each, and a read
 *    reassembles it — so an extra top-level field a caller hands over
 *    structurally is dropped, where the IndexedDB adapter would round-trip it.
 *    The id commits to exactly the six stored fields, so nothing
 *    authenticated is affected.
 *  - Reads and writes interleave on one connection inside `BEGIN IMMEDIATE`,
 *    so this is NOT written as guarded, read-free SQL. A second writer on the
 *    same file (the Android notification service) is still safe — `BEGIN
 *    IMMEDIATE` takes the write lock for the whole transaction — but only if
 *    that writer is equally disciplined about transactions.
 */
import { NKinds } from "@nostrify/nostrify";
import { utf8ToBytes } from "@noble/hashes/utils.js";

import { ParsedFilter } from "./ParsedFilter";
import { batch, memberOf, where } from "./sql";
import {
  ARMADA_DB_FTS_SCHEMA,
  ARMADA_DB_REBUILD_V1,
  ARMADA_DB_SCHEMA,
  ARMADA_DB_VERSION,
} from "./sqliteSchema";
import { defaultIndexTags, matchesKvRange, resolveKvRange } from "./types";

import type { NostrFilter } from "@nostrify/nostrify";
import type { NostrRumor } from "@/lib/nostrRumor";
import type { ArmadaSqlDriver, SqlRow, SqlValue } from "./driver";
import type {
  ArmadaDB,
  ArmadaDBOpts,
  ArmadaKV,
  ArmadaKVEntry,
  ArmadaKVListOptions,
  ArmadaKVSelector,
  NRumorStore,
  TenantOpts,
  TermPolicy,
} from "./types";

/** Bits of the rowid reserved for the per-second sequence number. */
const SEQ_BITS = 20;

/** Rowids per second: how many rumors may share one `created_at`. */
const SEQ_SPACE = 2 ** SEQ_BITS;

/**
 * Largest `created_at` the rowid encoding can carry (2106-02-07). Beyond this
 * the timestamp is clamped, which keeps the rowid a safe integer at the cost
 * of ordering *among* absurdly-dated rumors; plans touching such a rumor fall
 * back to matching it in memory, so results stay correct either way.
 */
const MAX_TIME = 0xffffffff;

/** How many candidate rows a paged scan reads per round trip. */
const CHUNK_SIZE = 512;

/**
 * Upper bound on bound parameters per statement. SQLite's own limit is 32766
 * on modern builds but only 999 on older ones, and some drivers impose their
 * own, so statements are split well below the floor.
 */
const MAX_PARAMS = 900;

/** Upper bound on the rows one page of a scan may read, however large the limit. */
const MAX_PAGE = 10_000;

/**
 * Longest `IN (…)` list driving a scan over the rumors table before it is
 * split across statements.
 */
const MAX_IN = 500;

/**
 * Most terms one MATCH expression may `OR` together. FTS5 opens an iterator
 * per term, so a very long list is split across statements and merged instead.
 */
const MAX_OR = 500;

/**
 * Most authors worth folding into the MATCH alongside a tag, rather than
 * testing on the rows the tag finds.
 *
 * Each author is one more posting list for FTS5 to merge, and an author's list
 * is long — everything they ever wrote — while `pubkey` on a row already
 * fetched is a column read. Measured crossover on a 20k store: one author in
 * the index is 8× faster than the pushdown, sixteen is a wash, and a hundred
 * is 5× slower.
 */
const MAX_AUTHOR_TERMS = 16;

/**
 * Longest value list used to *filter* (rather than drive) a scan. A longer one
 * is matched in memory instead, which keeps the parameter count bounded.
 */
const MAX_PUSHDOWN = 100;

/** How many rumors one page of the derived-term backfill re-derives. */
const BACKFILL_PAGE = 500;

/** The columns a stored rumor is reassembled from. */
const RUMOR_COLUMNS = "id, kind, pubkey, created_at, tags, content";

/** The same columns read through the `r` alias of a joined scan. */
const R_RUMOR_COLUMNS = "r.id, r.kind, r.pubkey, r.created_at, r.tags, r.content";

export interface SqliteArmadaDBOpts extends ArmadaDBOpts {
  /**
   * Whether to install the schema on construction. Pass `false` when the
   * transport owns the file's schema (the Android service does). Default
   * `true`.
   */
  migrate?: boolean;
  /**
   * Whether to maintain the FTS5 content index ({@link ARMADA_DB_FTS_SCHEMA})
   * that NIP-50 `search` filters are resolved against. Default `true`. The tag
   * token index is not optional — it is how tags are queryable at all.
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
  /** Whether the content index is maintained, and so usable by `search`. */
  private readonly search: boolean;
  private readonly stores = new Map<string, SqliteRumorStore>();
  /** Memoised {@link tenantOrd}s — one lookup per tenant, not per token. */
  private readonly ords = new Map<string, number>();
  /** Installed {@link TermPolicy}s, by tenant id. */
  private readonly termPolicies = new Map<string, TermPolicy>();
  /** Each tenant's one-time term backfill, which term reads wait on. */
  private readonly backfills = new Map<string, Promise<void>>();

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

  tenant(id: string, opts: TenantOpts = {}): NRumorStore {
    let store = this.stores.get(id);
    if (!store) {
      store = new SqliteRumorStore(this, id);
      this.stores.set(id, store);
    }
    if (opts.terms) this.installTerms(id, opts.terms);
    return store;
  }

  /**
   * Bind a tenant's {@link TermPolicy} and make sure its existing rows are
   * indexed by it.
   *
   * The policy lands on the TENANT, not on this handle, so a writer that asked
   * for the store without naming one still writes the terms — which is the
   * whole point of binding it here rather than at each write.
   */
  private installTerms(tenant: string, policy: TermPolicy): void {
    if (this.termPolicies.get(tenant) === policy) return;
    this.termPolicies.set(tenant, policy);
    // Rows written before this call carry none of the policy's terms, so the
    // index is incomplete until they have been through it. Kept as a promise
    // rather than awaited: acquiring a store is synchronous, and only a read
    // that actually NAMES a term has to wait (see `awaitTerms`).
    this.backfills.set(tenant, this.backfillTerms(tenant).catch(() => {}));
  }

  /** A rumor's derived terms in `tenant`, or none when it has no policy. */
  private termsOf(tenant: string, rumor: NostrRumor): string[] {
    const policy = this.termPolicies.get(tenant);
    return policy ? policy(rumor, tenant) : [];
  }

  /**
   * Wait for `tenant`'s term backfill, if a read is about to depend on it.
   *
   * Only reads that name a term wait. Ordinary reads are unaffected by a
   * half-built term index, and making them queue behind it would put a full
   * pass over the tenant in front of the first thing the UI asks for.
   */
  private async awaitTerms(tenant: string, filters: NostrFilter[]): Promise<void> {
    const pending = this.backfills.get(tenant);
    if (!pending) return;
    if (!filters.some((filter) => typeof filter.search === "string")) return;
    await pending;
  }

  /**
   * Derive and store the terms of every rumor already in `tenant`, once.
   *
   * A term can't be computed in SQL — the policy is JavaScript, and on the
   * native engines it is Kotlin or Swift — so a schema migration can't build
   * this index the way it can rebuild a column. It is filled by walking the
   * tenant instead, newest-first in pages, and the fact that it HAS been
   * walked is recorded in `rumor_term_tenants` so the pass happens once per
   * file rather than once per boot.
   *
   * Writes made while it runs are not a hazard: they go through the same
   * policy, and every insert here is `OR IGNORE`.
   */
  private async backfillTerms(tenant: string): Promise<void> {
    await this.ready;

    // A tenant that has never been written to has nothing to index — and no
    // ordinal to record the fact against. The next boot asks again, which
    // costs one lookup.
    const ord = await this.tenantOrd(tenant);
    if (ord === undefined) return;

    const [done] = await this.all(
      `SELECT 1 AS done FROM rumor_term_tenants WHERE tenant = ?`,
      [ord],
    );
    if (done) return;

    let before: number | undefined;

    for (;;) {
      const rows = await this.all(
        `SELECT seq, ${RUMOR_COLUMNS} FROM rumors INDEXED BY rumors_tenant
          WHERE tenant = ?${before === undefined ? "" : " AND seq < ?"}
          ORDER BY seq DESC LIMIT ?`.replace(/\s+/g, " "),
        before === undefined ? [ord, BACKFILL_PAGE] : [ord, before, BACKFILL_PAGE],
      );
      if (rows.length === 0) break;

      await this.transaction(async () => {
        for (const row of rows) {
          await this.insertTerms(ord, Number(row.seq), this.termsOf(tenant, rowRumor(row)));
        }
      });

      before = Number(rows[rows.length - 1].seq);
      if (rows.length < BACKFILL_PAGE) break;
    }

    await this.transaction(() =>
      this.run(`INSERT OR IGNORE INTO rumor_term_tenants (tenant) VALUES (?)`, [ord])
    );
  }

  /**
   * Create the tables, indexes and triggers this adapter needs, if they don't
   * already exist — upgrading a file laid out by an older schema version
   * first. Run from the constructor unless `migrate: false`.
   */
  async migrate(): Promise<void> {
    const [version] = await this.all(`PRAGMA user_version`);

    if (Number(version?.user_version ?? 0) < ARMADA_DB_VERSION) {
      // v0 predates versioning, so it is recognized by its layout: only v0
      // has the `json` column. A fresh file has no `rumors` table at all and
      // needs no rebuild.
      const [legacy] = await this.all(
        `SELECT 1 AS legacy FROM pragma_table_info('rumors') WHERE name = 'json'`,
      );

      if (legacy) {
        await this.transaction(async () => {
          for (const statement of ARMADA_DB_REBUILD_V1) {
            await this.run(statement.trim().replace(/\s+/g, " "));
          }
        });

        // Give the freed pages back to the filesystem. Outside the rebuild's
        // transaction — VACUUM can't run inside one — and advisory: the
        // rebuild is already durable, and a driver that can't VACUUM just
        // keeps the slack.
        try {
          await this.run(`VACUUM`);
        } catch {
          // keep the slack
        }
      }
    }

    const schema = this.search
      ? [...ARMADA_DB_SCHEMA, ...ARMADA_DB_FTS_SCHEMA]
      : ARMADA_DB_SCHEMA;

    for (const statement of schema) {
      await this.run(statement.trim().replace(/\s+/g, " "));
    }

    await this.run(`PRAGMA user_version = ${ARMADA_DB_VERSION}`);
  }

  /** Empty every table (logout purge). Keeps the schema. */
  async wipe(): Promise<void> {
    await this.ready;
    await this.transaction(async () => {
      // The triggers empty the index tables row by row; `delete-all` is FTS5's
      // own reset, and settles any row a policy change or a crash orphaned.
      await this.run(`DELETE FROM rumors`);
      await this.run(`INSERT INTO rumor_tags_fts (rumor_tags_fts) VALUES ('delete-all')`);
      if (this.search) {
        await this.run(`INSERT INTO rumors_fts (rumors_fts) VALUES ('delete-all')`);
      }
      await this.run(`DELETE FROM rumor_coords`);
      // Emptied explicitly rather than left to the trigger, for the same
      // reason as `delete-all` above: a row orphaned by a crash outlives the
      // rumor that would have taken it.
      await this.run(`DELETE FROM rumor_terms`);
      await this.run(`DELETE FROM rumor_term_tenants`);
      await this.run(`DELETE FROM tenants`);
      await this.run(`DELETE FROM kv`);
    });

    // Interned ids are reallocated from scratch after this, so a remembered
    // one would name the wrong tenant.
    this.ords.clear();

    // The tenants are gone, so nothing is backfilled any more — but the
    // policies stay bound, and an empty tenant needs no pass to be complete.
    this.backfills.clear();
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

    // The row is the rumor's six NIP-01 fields, one column each — so a `sig`
    // (or anything else a caller hands over structurally) is never stored,
    // and the adapters agree that the store holds rumors, nothing else.
    return new Promise<void>((resolve, reject) => {
      this.pending.push({ tenant, rumor, resolve, reject });
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
    const ord = await this.internTenant(tenant);
    const prefix = `t${ord}`;
    const terms = this.termsOf(tenant, rumor);
    let seq: number | undefined;

    if (NKinds.replaceable(rumor.kind) || NKinds.addressable(rumor.kind)) {
      const coord = getCoord(rumor);

      const [existing] = await this.all(
        `SELECT id, seq, created_at FROM rumor_coords WHERE tenant = ? AND coord = ?`,
        [ord, coord],
      );

      if (existing) {
        const stored = { id: String(existing.id), created_at: Number(existing.created_at) };
        // Per NIP-01 the stored version wins ties, and an identical id is a
        // no-op, so only a strictly newer rumor replaces it.
        if (!isNewer(rumor, stored)) return;
        await this.deleteRumors(ord, [Number(existing.seq)]);
      }

      seq = await this.insertRumor(ord, prefix, rumor, terms);
      if (seq === undefined) return;

      await this.run(
        `INSERT OR REPLACE INTO rumor_coords (tenant, coord, id, seq, created_at)
          VALUES (?, ?, ?, ?, ?)`,
        [ord, coord, rumor.id, seq, rumor.created_at],
      );
    } else {
      seq = await this.insertRumor(ord, prefix, rumor, terms);
      if (seq === undefined) return;
    }

    // Applied after the insert so a kind 5 arriving alongside its targets in
    // one batch still resolves. The request itself is retained.
    if (rumor.kind === 5) {
      await this.applyDeletion(ord, rumor);
    }
  }

  /**
   * Write the rumor row and its token index row, and return the rowid taken —
   * or `undefined` if the rumor was already stored, which makes a re-delivery
   * a no-op.
   *
   * Everything the write needs to know first — whether this rumor is already
   * here, and which rowid is free at its timestamp — is one statement, since
   * each is a scalar subquery over an index and neither depends on the other.
   * The rowid is allocated by LOOKING rather than from a counter held in
   * memory, so a second writer on the same file (the Android service) can't be
   * handed the same one; the bucket spans tenants, since the rowid is global.
   *
   * Folding that lookup into the INSERT with `RETURNING` would make this one
   * statement rather than two, and measured 2.7× SLOWER: an INSERT that
   * returns rows gives up SQLite's fast path and pays a result set per write,
   * which costs far more than the extra round trip saves.
   */
  private async insertRumor(
    ord: number,
    prefix: string,
    rumor: NostrRumor,
    terms: string[],
  ): Promise<number | undefined> {
    const base = bucket(rumor.created_at);

    const [row] = await this.all(
      `SELECT (SELECT seq FROM rumors WHERE tenant = ? AND id = ?) AS existing,
        (SELECT MAX(seq) FROM rumors WHERE seq >= ? AND seq < ?) AS last`,
      [ord, rumor.id, base, base + SEQ_SPACE],
    );

    // Already stored: a re-delivered rumor is a no-op.
    if (row?.existing !== null && row?.existing !== undefined) return undefined;

    const seq = row?.last === null || row?.last === undefined ? base : Number(row.last) + 1;

    // One second may hold 2²⁰ rumors. Anything that manages more of them at
    // the same timestamp has outgrown this encoding, and silently reordering
    // them — or spilling into the next second's rowids — would be worse than
    // saying so.
    if (seq >= base + SEQ_SPACE) {
      throw new Error(`ArmadaDB: too many rumors at created_at ${rumor.created_at}`);
    }

    await this.run(
      `INSERT INTO rumors (seq, tenant, id, kind, pubkey, created_at, tags, content)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        seq,
        ord,
        rumor.id,
        rumor.kind,
        rumor.pubkey,
        rumor.created_at,
        JSON.stringify(rumor.tags),
        rumor.content,
      ],
    );

    // The content index is written by a trigger, so this is the only index the
    // write path maintains itself — one row, however many tags the rumor has.
    await this.run(
      `INSERT INTO rumor_tags_fts (rowid, tokens) VALUES (?, ?)`,
      [seq, this.tagTokens(prefix, rumor)],
    );

    await this.insertTerms(ord, seq, terms);

    return seq;
  }

  /**
   * File a rumor's derived terms. `OR IGNORE` because a policy may return the
   * same term twice, and because the backfill runs over rows a live write may
   * already have indexed.
   */
  private async insertTerms(ord: number, seq: number, terms: string[]): Promise<void> {
    for (const term of terms) {
      if (typeof term !== "string" || term === "") continue;
      await this.run(
        `INSERT OR IGNORE INTO rumor_terms (tenant, term, seq) VALUES (?, ?, ?)`,
        [ord, term, seq],
      );
    }
  }

  /**
   * A rumor's index terms as a single space-separated token string: its
   * indexed tags, plus `<tenant>:_p:<pubkey>` so an author constraint can be
   * merged into the same MATCH as the tags.
   *
   * The *kind* deliberately gets no token: there are only a handful of kinds
   * in use, so `_k:1` would be a posting list covering a large share of the
   * store, and intersecting one of those costs more than testing `kind` on the
   * rows the tag already found.
   */
  private tagTokens(prefix: string, rumor: NostrRumor): string {
    const tokens: string[] = [`${prefix}:_p:${part(rumor.pubkey)}`];
    const seen = new Set<string>();

    for (const [name, value] of this.indexTags(rumor)) {
      if (typeof name !== "string" || typeof value !== "string") continue;
      const token = tagToken(prefix, name, value);
      if (seen.has(token)) continue;
      seen.add(token);
      tokens.push(token);
    }

    return tokens.join(" ");
  }

  /**
   * The integer a tenant's tokens name it by, or `undefined` if the tenant has
   * never been written to — in which case it holds no rumors, and so no tokens
   * either.
   *
   * Interned rather than derived from the id, so distinct tenants can't share
   * a prefix. A hash could: truncated, by birthday over ids that are partly
   * attacker-chosen (`c2:<community id>`), and sharing a prefix means sharing
   * posting lists, which is a cross-tenant read. Untruncated it would put 64
   * characters in front of every token in the index.
   *
   * One lookup per tenant per process — the answer is durable, so a second
   * writer on the same file agrees with it.
   */
  private async tenantOrd(tenant: string): Promise<number | undefined> {
    const cached = this.ords.get(tenant);
    if (cached !== undefined) return cached;

    const [row] = await this.all(`SELECT ord FROM tenants WHERE id = ?`, [tenant]);
    if (!row) return undefined;

    const ord = Number(row.ord);
    this.ords.set(tenant, ord);
    return ord;
  }

  /** The same, allocating one for a tenant being written to for the first time. */
  private async internTenant(tenant: string): Promise<number> {
    const existing = await this.tenantOrd(tenant);
    if (existing !== undefined) return existing;

    await this.run(`INSERT OR IGNORE INTO tenants (id) VALUES (?)`, [tenant]);

    const [row] = await this.all(`SELECT ord FROM tenants WHERE id = ?`, [tenant]);
    const ord = Number(row.ord);
    this.ords.set(tenant, ord);
    return ord;
  }

  /**
   * NIP-09: delete the rumors a kind 5 request targets, within its tenant.
   *
   * A request can only delete its author's own rumors, so every target is
   * checked against the request's `pubkey`. `a` tags additionally only delete
   * versions at or before the request's `created_at`, so a newer replacement
   * survives.
   */
  private async applyDeletion(ord: number, request: NostrRumor): Promise<void> {
    const targets = request.tags.filter(
      ([name, value]) => (name === "e" || name === "a") && !!value,
    );
    if (targets.length === 0) return;

    const seqs = new Set<number>();

    // A request can't delete itself, and a kind 5 occupies no coordinate, so
    // dropping its own id from the `e` targets is the whole of that rule.
    const eTags = targets
      .filter(([name, value]) => name === "e" && value !== request.id)
      .map(([, value]) => value);
    const aTags = targets.filter(([name]) => name === "a").map(([, value]) => value);

    for (const chunk of batch(eTags, MAX_PARAMS - 2)) {
      const rows = await this.all(
        `SELECT seq FROM rumors WHERE tenant = ? AND ${memberOf("id", chunk)} AND pubkey = ?`,
        [ord, ...chunk, request.pubkey],
      );
      for (const row of rows) seqs.add(Number(row.seq));
    }

    // Only one version of a coordinate is ever stored, so an `a` tag resolves
    // to at most one rumor via a primary-key lookup.
    const owned = aTags.filter((coord) => coord.split(":")[1] === request.pubkey);

    for (const chunk of batch(owned, MAX_PARAMS - 2)) {
      const rows = await this.all(
        `SELECT seq FROM rumor_coords
          WHERE tenant = ? AND ${memberOf("coord", chunk)} AND created_at <= ?`,
        [ord, ...chunk, request.created_at],
      );
      for (const row of rows) seqs.add(Number(row.seq));
    }

    await this.deleteRumors(ord, [...seqs]);
  }

  /**
   * Delete rumors by rowid, along with any coordinate they occupy. Their index
   * rows go with them, dropped by the triggers — one statement, however many
   * tags the rumor had.
   *
   * Coordinates are removed by their primary key, recomputed from the stored
   * rumor, so the coordinate table needs no secondary index on `seq`.
   */
  private async deleteRumors(ord: number, seqs: number[]): Promise<void> {
    if (seqs.length === 0) return;

    for (const chunk of batch(seqs, MAX_PARAMS - 1)) {
      const rows = await this.all(
        `SELECT kind, pubkey, tags FROM rumors WHERE ${memberOf("seq", chunk)}`,
        chunk,
      );

      // Only a coordinate-bearing rumor needs its tags parsed, to find the
      // `d` tag its coordinate is built from.
      const coords = rows
        .filter((row) => NKinds.replaceable(Number(row.kind)) || NKinds.addressable(Number(row.kind)))
        .map((row) =>
          getCoord({
            kind: Number(row.kind),
            pubkey: String(row.pubkey),
            tags: JSON.parse(String(row.tags)) as string[][],
          })
        );

      for (const coordChunk of batch(coords, MAX_PARAMS - 1)) {
        await this.run(
          `DELETE FROM rumor_coords WHERE tenant = ? AND ${memberOf("coord", coordChunk)}`,
          [ord, ...coordChunk],
        );
      }

      await this.run(`DELETE FROM rumors WHERE ${memberOf("seq", chunk)}`, chunk);
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
    await this.awaitTerms(tenant, filters);

    // A tenant that was never written to holds nothing, whatever the filters.
    const ord = await this.tenantOrd(tenant);
    if (ord === undefined) return [];

    const byId = new Map<string, NostrRumor>();
    const prefix = `t${ord}`;

    // Run sequentially: the driver holds a single connection, so concurrency
    // would buy nothing and could interleave badly.
    for (const filter of filters) {
      const parsed = new ParsedFilter(filter);
      for (const rumor of await this.queryFilter(ord, prefix, parsed, opts?.signal)) {
        byId.set(rumor.id, rumor);
      }
    }

    return [...byId.values()].sort(compareNewest);
  }

  /** Run a single parsed filter through the planner. */
  private async queryFilter(
    ord: number,
    prefix: string,
    filter: ParsedFilter,
    signal?: AbortSignal,
  ): Promise<NostrRumor[]> {
    if (filter.neverMatch) return [];

    const limit = filter.limit ?? Infinity;
    if (limit <= 0) return [];

    signal?.throwIfAborted();

    const plan = this.planScan(ord, prefix, filter);

    // ids plans are lookups by key, not scans.
    if (plan.ids) {
      return await this.queryIds(ord, plan.ids, filter, limit);
    }

    // A cursor yields only rows its conditions kept, and the limit is applied
    // after them, so a single complete plan IS the answer: run it once and
    // read the rumor bodies straight out of it.
    if (plan.cursors.length === 1 && plan.sqlOnly) {
      const rows = await this.readPage(
        plan.cursors[0],
        undefined,
        limit === Infinity ? undefined : limit,
        false,
      );
      const found = rows.map((row) => row.rumor);
      found.sort(compareNewest);
      return found;
    }

    const collected: NostrRumor[] = [];
    const seen = new Set<string>();

    // A complete plan yields only matches, so a page need be no larger than
    // what's still wanted; an incomplete one pages in chunks so a filter that
    // matches little doesn't materialize the whole range.
    let pageSize = plan.sqlOnly ? Math.min(limit, MAX_PAGE) : CHUNK_SIZE;

    let before: number | undefined;

    while (collected.length < limit) {
      signal?.throwIfAborted();

      const page = await this.scanPage(plan, before, pageSize);
      if (page.length === 0) break;

      before = page[page.length - 1].seq;

      for (const { rumor } of page) {
        if (collected.length >= limit) break;
        if (seen.has(rumor.id)) continue;
        seen.add(rumor.id);

        if (plan.sqlOnly || filter.matches(rumor, plan.searched)) collected.push(rumor);
      }

      // A short page means the scan is exhausted.
      if (page.length < pageSize) break;

      // Still short of the limit after a full page, so the conditions are
      // rejecting more than they're keeping. Widening geometrically bounds the
      // number of round trips a very selective filter costs.
      pageSize = Math.min(pageSize * 4, MAX_PAGE);
    }

    collected.sort(compareNewest);
    return collected;
  }

  /** Fetch rumors by id, applying whatever else the filter asks for. */
  private async queryIds(
    ord: number,
    ids: string[],
    filter: ParsedFilter,
    limit: number,
  ): Promise<NostrRumor[]> {
    const rumors: NostrRumor[] = [];

    for (const chunk of batch(ids, MAX_PARAMS - 16)) {
      const conditions = ["tenant = ?", memberOf("id", chunk)];
      const params: SqlValue[] = [ord, ...chunk];

      if (filter.since !== undefined) {
        conditions.push("created_at >= ?");
        params.push(filter.since);
      }
      if (filter.until !== undefined) {
        conditions.push("created_at <= ?");
        params.push(filter.until);
      }
      if (filter.kinds && filter.kinds.length <= MAX_PUSHDOWN) {
        conditions.push(memberOf("kind", filter.kinds));
        params.push(...filter.kinds);
      }
      if (filter.authors && filter.authors.length <= MAX_PUSHDOWN) {
        conditions.push(memberOf("pubkey", filter.authors));
        params.push(...filter.authors);
      }

      for (
        const row of await this.all(`SELECT ${RUMOR_COLUMNS} FROM rumors${where(conditions)}`, params)
      ) {
        const rumor = rowRumor(row);
        // The SQL already applied the ids byte-exactly; see `matches`.
        if (filter.matches(rumor, false, true)) rumors.push(rumor);
      }
    }

    rumors.sort(compareNewest);
    return rumors.length > limit ? rumors.slice(0, limit) : rumors;
  }

  /** Read one page of rumors, newest-first, merging the plan's cursors. */
  private async scanPage(
    plan: ScanPlan,
    before: number | undefined,
    pageSize: number,
  ): Promise<Candidate[]> {
    if (plan.cursors.length === 1) {
      return await this.readPage(plan.cursors[0], before, pageSize);
    }

    const merged: Candidate[] = [];

    for (const cursor of plan.cursors) {
      merged.push(...await this.readPage(cursor, before, pageSize));
    }

    merged.sort((a, b) => b.seq - a.seq);
    return merged.slice(0, pageSize);
  }

  /**
   * Read one cursor's next rows, newest-first.
   *
   * Both kinds of cursor are read the same way, and the shape is the point:
   * conditions first, `LIMIT` last. A full-text cursor joins the rows its
   * index found to the rumors table and tests what the index couldn't carry
   * THERE, before the limit — so SQLite walks the posting lists backwards and
   * stops as soon as `limit` rows have survived everything. Applying the limit
   * to the index scan instead would make a page come back short of what was
   * asked for, and the shortfall would have to be chased in JavaScript.
   *
   * Either way, every row that comes back is a row the SQL kept, and the next
   * page resumes strictly below the last of them.
   *
   * `CROSS JOIN` is load-bearing, and is the whole reason that works. It is
   * SQLite's one way to fix a join order, and without it a condition on the
   * rumors table is enough to make the planner drive from THERE instead —
   * seeking the index by rowid once per row, which re-evaluates the MATCH
   * every time, and then sorting the result through a temp b-tree. Measured on
   * a 20k store that is 462ms against 0.16ms. See the plan test.
   */
  private async readPage(
    cursor: ScanCursor,
    before: number | undefined,
    limit: number | undefined,
    keys = true,
  ): Promise<Candidate[]> {
    let sql: string;
    const params: SqlValue[] = [];

    if (!("from" in cursor)) {
      const scan = this.ftsScan(cursor, before);
      params.push(...scan.params, ...(cursor.where ? cursor.params ?? [] : []));

      sql = `SELECT ${keys ? "r.seq, " : ""}${R_RUMOR_COLUMNS} FROM ${scan.driver}
        CROSS JOIN rumors r ON r.seq = ${scan.driver}.rowid${
        where([...scan.conditions, ...(cursor.where ?? [])])
      } ORDER BY ${scan.driver}.rowid DESC${limit === undefined ? "" : " LIMIT ?"}`;
    } else {
      const conditions = [...cursor.where];
      params.push(...cursor.params);
      // A scan of the rumors table alone is ordered and paged by its own
      // rowid; a scan driven by an index table beside it (`rumor_terms`) is
      // ordered by the copy of that rowid in the driver, so the walk belongs
      // to the index and not to a sort of what it found.
      const key = cursor.key ?? "seq";

      if (before !== undefined) {
        conditions.push(`${key} < ?`);
        params.push(before);
      }

      // The key is only read when a later page has to resume from it; a scan
      // that answers the whole query in one go leaves the column out.
      sql = `SELECT ${keys ? `${key} AS seq, ` : ""}${cursor.columns ?? RUMOR_COLUMNS} FROM ${cursor.from}${
        where(conditions)
      } ORDER BY ${key} DESC${limit === undefined ? "" : " LIMIT ?"}`;
    }

    if (limit !== undefined) params.push(limit);

    const rows = await this.all(sql.replace(/\s+/g, " "), params);

    return rows.map((row) => ({
      seq: keys ? Number(row.seq) : 0,
      rumor: rowRumor(row),
    }));
  }

  /**
   * The index scan behind a full-text cursor: which table drives it, and the
   * conditions that bound it.
   *
   * Tokens drive whenever there are tokens, since the token index also carries
   * the tenant, the time window and the ordering; a keyword-only filter drives
   * the content index the same way. Keywords *alongside* tokens are a second
   * index to intersect with, which FTS5 can't do across tables, so they are
   * resolved to a set the driving scan tests against.
   */
  private ftsScan(
    cursor: FtsCursor,
    before: number | undefined,
  ): { driver: string; conditions: string[]; params: SqlValue[] } {
    const driver = cursor.match ? "rumor_tags_fts" : "rumors_fts";
    const conditions = [`${driver} MATCH ?`];
    const params: SqlValue[] = [cursor.match ?? cursor.search!];

    if (cursor.match && cursor.search) {
      // The `+` is load-bearing. Without it SQLite hands the rowid list to the
      // *token* index as a constraint, which turns one descending scan into
      // one scan per keyword match; with it, the list stays an ordinary filter
      // over a single scan, and SQLite builds a bloom filter for it.
      conditions.push(
        `+${driver}.rowid IN (SELECT rowid FROM rumors_fts WHERE rumors_fts MATCH ?)`,
      );
      params.push(cursor.search);
    }

    // Bounded on the driver's own rowid, not on the joined `r.seq`: the point
    // is for FTS5 to receive the range and stop its walk, rather than for the
    // rows to be discarded after it has walked them all.
    if (cursor.min !== undefined) {
      conditions.push(`${driver}.rowid >= ?`);
      params.push(cursor.min);
    }

    // The paging bound and the filter's `until` are the same kind of
    // constraint, so whichever is tighter is the one that's applied.
    const max = before !== undefined ? before - 1 : cursor.max;

    if (max !== undefined) {
      conditions.push(`${driver}.rowid <= ?`);
      params.push(max);
    }

    return { driver, conditions, params };
  }

  /**
   * The query planner.
   *
   * A filter that names a tag or a keyword is driven by the index, which finds
   * its rows newest-first and lets the rumors table test what's left. Anything
   * else is driven by a b-tree, chosen by strfry's priority cascade — every
   * one of those indexes leads with `tenant` and is ordered by time already,
   * so each is read newest-first, within one namespace, with no sorter.
   */
  private planScan(ord: number, prefix: string, filter: ParsedFilter): ScanPlan {
    const { min, max, exact } = timeRange(filter);

    // 0. derived terms — ahead of everything, including ids, because nothing
    //    else can apply them: they are not in the rumor, so a plan that didn't
    //    resolve them in the index has no way to check them afterwards.
    if (filter.terms.length > 0) {
      return this.planTerms(ord, filter, min, max, exact);
    }

    // 1. ids — the (tenant, id) unique index.
    if (filter.ids) {
      return { ids: filter.ids, cursors: [], sqlOnly: false, searched: false };
    }

    // Without the content index there is nothing to resolve keywords against,
    // so they fall through to the in-memory match instead.
    const search = this.search ? filter.searchQuery : undefined;

    // 2. tags, or a NIP-50 search: the index drives.
    if (filter.tags.length > 0 || search) {
      const plan = this.planFts(ord, prefix, filter, search, min, max, exact);
      if (plan) return plan;
    }

    /** Append the filter's time bounds to a rumors-table cursor. */
    const addTime = (conditions: string[], params: SqlValue[]): void => {
      // The rowid bound is what stops the scan early; the `created_at` test is
      // what makes it exact, for the timestamps the encoding has to clamp.
      if (min !== undefined) {
        conditions.push("seq >= ?");
        params.push(min);
      }
      if (max !== undefined) {
        conditions.push("seq <= ?");
        params.push(max);
      }
      if (filter.since !== undefined) {
        conditions.push("created_at >= ?");
        params.push(filter.since);
      }
      if (filter.until !== undefined) {
        conditions.push("created_at <= ?");
        params.push(filter.until);
      }
    };

    const searched = !filter.searchKeywords;
    const pushKinds = !filter.kinds || filter.kinds.length <= MAX_PUSHDOWN;

    // 3. authors + kinds, from the composite index. The seeks land in an index
    //    whose entries are (tenant, pubkey, kind, time) in that order, so each
    //    walks straight to the newest rumors of a combination and stops.
    if (filter.authors && filter.kinds && pushKinds) {
      const cursors = [...batch(filter.authors, MAX_IN)].map((authors): ScanCursor => {
        const conditions = [
          "tenant = ?",
          memberOf("pubkey", authors),
          memberOf("kind", filter.kinds!),
        ];
        const params: SqlValue[] = [ord, ...authors, ...filter.kinds!];

        addTime(conditions, params);

        return { from: "rumors INDEXED BY rumors_pubkey_kind", where: conditions, params };
      });

      return { cursors, sqlOnly: searched, searched };
    }

    // 4. authors alone, with kinds filtering the scan when there are few
    //    enough of them to be worth binding.
    if (filter.authors) {
      const cursors = [...batch(filter.authors, MAX_IN)].map((authors): ScanCursor => {
        const conditions = ["tenant = ?", memberOf("pubkey", authors)];
        const params: SqlValue[] = [ord, ...authors];

        addTime(conditions, params);

        if (filter.kinds && pushKinds) {
          conditions.push(memberOf("kind", filter.kinds));
          params.push(...filter.kinds);
        }

        return { from: "rumors INDEXED BY rumors_pubkey", where: conditions, params };
      });

      return { cursors, sqlOnly: searched && pushKinds, searched };
    }

    // 5. kinds.
    if (filter.kinds) {
      const cursors = [...batch(filter.kinds, MAX_IN)].map((kinds): ScanCursor => {
        const conditions = ["tenant = ?", memberOf("kind", kinds)];
        const params: SqlValue[] = [ord, ...kinds];

        addTime(conditions, params);

        return { from: "rumors INDEXED BY rumors_kind", where: conditions, params };
      });

      return { cursors, sqlOnly: searched, searched };
    }

    // 6. fallback — the whole tenant, newest-first. `(tenant)` is `(tenant,
    //    seq)`, so this is a backwards walk of one contiguous index range.
    const conditions = ["tenant = ?"];
    const params: SqlValue[] = [ord];
    addTime(conditions, params);

    return {
      cursors: [{ from: "rumors INDEXED BY rumors_tenant", where: conditions, params }],
      sqlOnly: searched,
      searched,
    };
  }

  /**
   * Plan a filter as one or more MATCH expressions, or `undefined` when the
   * index can't drive it.
   *
   * Every constraint becomes a group of alternatives — the tag values, the
   * authors — and the groups are ANDed. FTS5 evaluates that by merging the
   * groups' doclists, so the cost is the length of the *shortest* group rather
   * than the product of them all.
   */
  private planFts(
    ord: number,
    prefix: string,
    filter: ParsedFilter,
    search: string | undefined,
    min: number | undefined,
    max: number | undefined,
    exact: boolean,
  ): ScanPlan | undefined {
    const groups: string[][] = [];

    for (const tag of filter.tags) {
      groups.push(tag.values.map((value) => tagToken(prefix, tag.name, value)));
    }

    // A search whose keywords are all negations has nothing for FTS5 to match
    // against — there is no way to say "every row except these" — so it is
    // left to the in-memory matcher, as is any search at all when the content
    // index isn't maintained.
    const searched = !filter.searchKeywords || !!search;

    // Authors join the tags in the index, where they are one more posting list
    // to intersect. Without a tag to intersect *with*, they are better served
    // by their own b-tree, so they're only added here when there is one — and
    // only while there are few enough of them to be worth merging.
    const inIndex = groups.length > 0 && !!filter.authors &&
      filter.authors.length <= MAX_AUTHOR_TERMS;

    if (inIndex) {
      groups.push(filter.authors!.map((pubkey) => `${prefix}:_p:${part(pubkey)}`));
    }

    if (groups.length === 0 && !search) return undefined;

    // Whatever the index isn't carrying is tested on the rows it finds, which
    // is what the rumors table is for. Every condition still ends up in SQL —
    // it just costs a column read on a row already fetched instead of a
    // posting list intersection over the whole store.
    const conditions: string[] = [];
    const params: SqlValue[] = [];

    // A token carries its tenant; the content index does not, so a
    // keyword-only scan is the one that has to say so.
    if (groups.length === 0) {
      conditions.push("r.tenant = ?");
      params.push(ord);
    }

    if (filter.kinds && filter.kinds.length <= MAX_PUSHDOWN) {
      conditions.push(memberOf("r.kind", filter.kinds));
      params.push(...filter.kinds);
    }

    if (!inIndex && filter.authors && filter.authors.length <= MAX_PUSHDOWN) {
      conditions.push(memberOf("r.pubkey", filter.authors));
      params.push(...filter.authors);
    }

    // Timestamps the rowid encoding had to clamp are re-checked exactly here,
    // rather than in memory.
    if (!exact && filter.since !== undefined) {
      conditions.push("r.created_at >= ?");
      params.push(filter.since);
    }
    if (!exact && filter.until !== undefined) {
      conditions.push("r.created_at <= ?");
      params.push(filter.until);
    }

    const complete = (!filter.kinds || filter.kinds.length <= MAX_PUSHDOWN) &&
      (inIndex || !filter.authors || filter.authors.length <= MAX_PUSHDOWN);

    // The longest group is the one worth splitting: every cursor carries every
    // other group in full, so splitting a short one would repeat more work.
    const longest = groups.reduce((a, b) => (b.length > a.length ? b : a), groups[0] ?? []);
    const chunks = longest.length > MAX_OR ? [...batch(longest, MAX_OR)] : [longest];

    const cursors: ScanCursor[] = chunks.map((chunk): ScanCursor => ({
      match: groups.length > 0
        ? matchExpr(groups.map((group) => (group === longest ? chunk : group)))
        : undefined,
      search,
      min,
      max,
      where: conditions,
      params,
    }));

    return { cursors, sqlOnly: complete && searched, searched };
  }

  /**
   * Plan a filter that names derived terms: `rumor_terms` drives, and
   * everything else is tested on the rows it finds.
   *
   * One term is a seek to `(tenant, term)` and a backwards walk of the `seq`
   * range under it — already time-ordered, so the walk stops at the limit with
   * no sorter and no bodies read past it. Further terms are `EXISTS` against
   * the same table, which is a point lookup per candidate rather than a second
   * scan to intersect.
   *
   * The `CROSS JOIN` fixes the join order for the reason it does in
   * {@link readPage}: the rumors table must be the INNER side, seeked by
   * rowid, or a condition on one of its columns is enough to make the planner
   * drive from there and sort the result afterwards.
   */
  private planTerms(
    ord: number,
    filter: ParsedFilter,
    min: number | undefined,
    max: number | undefined,
    exact: boolean,
  ): ScanPlan {
    const [driving, ...rest] = filter.terms;
    const conditions = ["x.tenant = ?", "x.term = ?"];
    const params: SqlValue[] = [ord, driving];

    if (min !== undefined) {
      conditions.push("x.seq >= ?");
      params.push(min);
    }
    if (max !== undefined) {
      conditions.push("x.seq <= ?");
      params.push(max);
    }

    for (const term of rest) {
      conditions.push(
        "EXISTS (SELECT 1 FROM rumor_terms y WHERE y.tenant = x.tenant AND y.term = ? AND y.seq = x.seq)",
      );
      params.push(term);
    }

    let complete = true;

    // ids are pushed down here rather than taking the ids plan: that plan
    // can't apply a term, and this one can apply an id.
    if (filter.ids) {
      if (filter.ids.length <= MAX_PUSHDOWN) {
        conditions.push(memberOf("r.id", filter.ids));
        params.push(...filter.ids);
      } else {
        complete = false;
      }
    }

    if (filter.kinds) {
      if (filter.kinds.length <= MAX_PUSHDOWN) {
        conditions.push(memberOf("r.kind", filter.kinds));
        params.push(...filter.kinds);
      } else {
        complete = false;
      }
    }

    if (filter.authors) {
      if (filter.authors.length <= MAX_PUSHDOWN) {
        conditions.push(memberOf("r.pubkey", filter.authors));
        params.push(...filter.authors);
      } else {
        complete = false;
      }
    }

    // Timestamps the rowid encoding had to clamp are re-checked exactly.
    if (!exact && filter.since !== undefined) {
      conditions.push("r.created_at >= ?");
      params.push(filter.since);
    }
    if (!exact && filter.until !== undefined) {
      conditions.push("r.created_at <= ?");
      params.push(filter.until);
    }

    // Tags and keywords are each a full-text index, and the term index is a
    // third — so rather than intersect indexes (which SQLite cannot do across
    // tables) each is resolved to a rowid set the term's walk tests against.
    // The term drives because it is the selective one: a conversation is a
    // handful of rows where `#p` is everything ever sent to a person.
    if (filter.tags.length > 0) {
      // A value list long enough to need splitting has no split to be given
      // here — there is one statement, not one cursor per chunk — so it goes
      // to the in-memory matcher instead, which reads the tags off rows the
      // term has already narrowed to.
      if (filter.tags.some((tag) => tag.values.length > MAX_OR)) {
        complete = false;
      } else {
        conditions.push(
          "x.seq IN (SELECT rowid FROM rumor_tags_fts WHERE rumor_tags_fts MATCH ?)",
        );
        params.push(
          matchExpr(
            filter.tags.map((tag) => tag.values.map((value) => tagToken(`t${ord}`, tag.name, value))),
          ),
        );
      }
    }

    const search = this.search ? filter.searchQuery : undefined;
    const searched = !filter.searchKeywords || !!search;

    if (search) {
      conditions.push("x.seq IN (SELECT rowid FROM rumors_fts WHERE rumors_fts MATCH ?)");
      params.push(search);
    }

    return {
      cursors: [{
        from: "rumor_terms x CROSS JOIN rumors r ON r.seq = x.seq",
        key: "x.seq",
        columns: R_RUMOR_COLUMNS,
        where: conditions,
        params,
      }],
      sqlOnly: complete && searched,
      searched,
    };
  }

  /** How many rumors in `tenant` match. */
  async countTenant(
    tenant: string,
    filters: NostrFilter[],
    opts?: { signal?: AbortSignal },
  ): Promise<{ count: number; approximate: boolean }> {
    await this.ready;
    await this.awaitTerms(tenant, filters);

    // A single complete plan is counted inside the index: no rows returned, no
    // rumor bodies read. One rumor is one row of the token index however many
    // of its tags matched, so nothing has to be de-duplicated.
    if (filters.length === 1) {
      const filter = new ParsedFilter(filters[0]);
      if (filter.neverMatch) return { count: 0, approximate: false };

      if (filter.limit === undefined) {
        // A tenant that was never written to holds nothing to count.
        const ord = await this.tenantOrd(tenant);
        if (ord === undefined) return { count: 0, approximate: false };

        const plan = this.planScan(ord, `t${ord}`, filter);

        if (plan.sqlOnly && !plan.ids && plan.cursors.length === 1) {
          const [cursor] = plan.cursors;
          let sql: string;
          const params: SqlValue[] = [];

          if (!("from" in cursor)) {
            const scan = this.ftsScan(cursor, undefined);
            params.push(...scan.params);

            // With nothing left to test, the index knows the answer by itself.
            // Otherwise the rows still have to be visited, but only their
            // columns, never their bodies.
            if (cursor.where?.length) {
              params.push(...(cursor.params ?? []));
              sql = `SELECT COUNT(*) AS count FROM ${scan.driver}
                CROSS JOIN rumors r ON r.seq = ${scan.driver}.rowid${
                where([...scan.conditions, ...cursor.where])
              }`;
            } else {
              sql = `SELECT COUNT(*) AS count FROM ${scan.driver}${where(scan.conditions)}`;
            }
          } else {
            sql = `SELECT COUNT(*) AS count FROM ${cursor.from}${where(cursor.where)}`;
            params.push(...cursor.params);
          }

          const [row] = await this.all(sql.replace(/\s+/g, " "), params);
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

    // Non-empty results mean the tenant has been written to, so it has an
    // ordinal.
    const ord = await this.tenantOrd(tenant);
    if (ord === undefined) return;

    await this.transaction(async () => {
      const seqs: number[] = [];

      for (const chunk of batch(rumors.map((rumor) => rumor.id), MAX_PARAMS - 1)) {
        const rows = await this.all(
          `SELECT seq FROM rumors WHERE tenant = ? AND ${memberOf("id", chunk)}`,
          [ord, ...chunk],
        );
        for (const row of rows) seqs.push(Number(row.seq));
      }

      await this.deleteRumors(ord, seqs);
    });
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

  async list<T>(
    selector?: ArmadaKVSelector,
    opts: ArmadaKVListOptions = {},
  ): Promise<ArmadaKVEntry<T>[]> {
    const range = resolveKvRange(selector);
    if (range.empty) return [];
    await this.db.ready;

    const conditions: string[] = [];
    const params: SqlValue[] = [];
    if (range.lower !== undefined) {
      conditions.push(`key >= ?`);
      params.push(range.lower);
    }
    if (range.upper !== undefined) {
      conditions.push(`key < ?`);
      params.push(range.upper);
    }

    // A limit only reaches SQL when the scan's own order is the answer's — see
    // `KvRange.exact`. Otherwise the rows dropped below would come off the top
    // of a short page.
    let sql = `SELECT key, value FROM kv${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""}` +
      ` ORDER BY key${opts.reverse ? " DESC" : ""}`;
    if (range.exact && opts.limit !== undefined) {
      sql += ` LIMIT ?`;
      params.push(opts.limit);
    }

    const rows = await this.db.all(sql, params);
    let entries = rows.map((row) => ({
      key: String(row.key),
      value: JSON.parse(String(row.value)) as T,
    }));
    // The range is a scan hint, not the contract — see `matchesKvRange`.
    if (!range.exact) {
      entries = entries.filter((entry) => matchesKvRange(entry.key, range));
      if (opts.limit !== undefined && entries.length > opts.limit) entries = entries.slice(0, opts.limit);
    }
    return entries;
  }
}

/** The first rowid belonging to a timestamp, clamped to the encodable range. */
function bucket(created_at: number): number {
  const time = Math.min(Math.max(Math.floor(created_at), 0), MAX_TIME);
  return time * SEQ_SPACE;
}

/**
 * The rowid window a filter's `since`/`until` bounds describe, and whether that
 * window is exact — it isn't when a bound falls outside the range the rowid
 * encoding can represent, in which case the rumors in the clamped bucket have
 * to be re-checked against `created_at`.
 */
function timeRange(filter: ParsedFilter): { min?: number; max?: number; exact: boolean } {
  let exact = true;
  let min: number | undefined;
  let max: number | undefined;

  if (filter.since !== undefined) {
    if (filter.since > MAX_TIME || filter.since < 0) exact = false;
    min = bucket(filter.since);
  }

  if (filter.until !== undefined) {
    if (filter.until > MAX_TIME || filter.until < 0) exact = false;
    max = bucket(filter.until) + SEQ_SPACE - 1;
  }

  return { min, max, exact };
}

/** The `kind:pubkey:d` coordinate of a replaceable or addressable rumor. */
function getCoord(rumor: Pick<NostrRumor, "kind" | "pubkey" | "tags">): string {
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

/** Reassemble a rumor from its row ({@link RUMOR_COLUMNS}). */
function rowRumor(row: SqlRow): NostrRumor {
  return {
    id: String(row.id),
    pubkey: String(row.pubkey),
    created_at: Number(row.created_at),
    kind: Number(row.kind),
    tags: JSON.parse(String(row.tags)) as string[][],
    content: String(row.content),
  };
}

/** Newest-first; ties broken by smaller id first (NIP-01). */
function compareNewest(a: NostrRumor, b: NostrRumor): number {
  if (a.created_at !== b.created_at) return b.created_at - a.created_at;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Tokens are only safe to embed verbatim when the tokenizer can't split or
 * fold them: lowercase ASCII alphanumerics, and nothing else.
 */
const VERBATIM = /^[0-9a-z]+$/;

/**
 * Encode one part of a tag token.
 *
 * Verbatim where possible — rumor ids, pubkeys and Armada's tag names
 * (`channel`, `stream`, `peer`) already qualify, and they're the values worth
 * optimizing for. Anything else is hex-escaped, which no tokenizer will split
 * and no case folding will alter. The two forms can't be confused: an escaped
 * value starts with `_`, which a verbatim one can never contain.
 */
function part(value: string): string {
  if (VERBATIM.test(value)) return value;

  let hex = "_";
  for (const byte of utf8ToBytes(value)) {
    hex += byte.toString(16).padStart(2, "0");
  }

  return hex;
}

/**
 * The index token for a tag within a tenant, e.g. `main:e:<id>` or
 * `main:t:_c3a9`.
 *
 * The tenant prefix can never be mistaken for a tag name, and the reserved
 * `_p:` author prefix can never be produced by a user's tag: an escaped name
 * is `_` followed by an EVEN number of hex digits, and `p` is not a hex digit
 * at all.
 */
function tagToken(prefix: string, name: string, value: string): string {
  return `${prefix}:${part(name)}:${part(value)}`;
}

/**
 * Build an FTS5 MATCH expression: each group's tokens are alternatives, and
 * the groups are required together.
 *
 * A group with one member is written as a bare phrase rather than a
 * parenthesized alternation, which is the same query with less for FTS5's
 * parser to chew through — and single-value groups are the common case.
 */
function matchExpr(groups: string[][]): string {
  return groups
    .map((group) => (group.length === 1 ? phrase(group[0]) : `(${group.map(phrase).join(" OR ")})`))
    .join(" AND ");
}

/**
 * A token as an FTS5 phrase. Quoting is what keeps a keyword like `OR` or `(`
 * from being read as query syntax; embedded quotes are doubled, per FTS5.
 */
function phrase(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

/** A rumor queued for the next batched commit, with its caller's settlers. */
interface PendingWrite {
  tenant: string;
  rumor: NostrRumor;
  resolve(): void;
  reject(error: unknown): void;
}

/**
 * A row a scan produced: the rumor, and its rowid, which is where a later page
 * resumes from.
 */
interface Candidate {
  seq: number;
  rumor: NostrRumor;
}

/**
 * One scan: either a full-text match over a window of rowids, or a b-tree scan
 * over the rumors table.
 */
type ScanCursor = FtsCursor | TableCursor;

/**
 * A full-text scan, bounded by the filter's time range: a token expression, a
 * NIP-50 keyword expression, or both, plus whatever conditions are left for
 * the rumors rows it finds.
 */
interface FtsCursor {
  match?: string;
  search?: string;
  min?: number;
  max?: number;
  /** Conditions on the matched rumors, as `r.column …`. */
  where?: string[];
  params?: SqlValue[];
}

/**
 * A b-tree scan: the rumors table with a forced index, or an index table
 * joined to it (the derived-term index).
 */
interface TableCursor {
  from: string;
  where: string[];
  params: SqlValue[];
  /**
   * The expression the scan is ordered and paged by, defaulting to `seq`.
   *
   * A join names it on the DRIVING table (`x.seq`), which is what keeps the
   * walk inside that table's index instead of sorting whatever the join
   * produced.
   */
  key?: string;
  /** The rumor columns, when they need an alias ({@link R_RUMOR_COLUMNS}). */
  columns?: string;
}

/** A planned scan: how to fetch a single filter's rumors. */
interface ScanPlan {
  /** For ids plans: fetch these keys directly instead of scanning. */
  ids?: string[];
  /**
   * Normally one scan. A filter with a value list too long for a single MATCH
   * — or for one statement's parameter budget — is split into several, merged
   * by the caller.
   */
  cursors: ScanCursor[];
  /** Whether the cursors express the filter completely. */
  sqlOnly: boolean;
  /** Whether the plan applies the filter's NIP-50 keywords itself. */
  searched: boolean;
}
