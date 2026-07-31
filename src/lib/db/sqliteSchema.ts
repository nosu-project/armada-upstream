/**
 * The SQLite schema behind {@link SqliteArmadaDB} — a port of Nostrify's
 * `NSQLite` (itself a port of strfry's LMDB query engine) with a `tenant`
 * column threaded through every table.
 *
 * SQLite is treated as a **key/value store plus hand-maintained indexes**, not
 * as a relational model. There are no joins anywhere: the query planner in
 * SqliteArmadaDB picks one index, scans it for candidate keys, and fetches the
 * bodies by primary key. A tags table joined against a rumors table would hand
 * the plan to SQLite's cost estimates, which pick badly for Nostr's shape (a
 * few very selective terms, an unbounded `created_at DESC` ordering, and a
 * small limit).
 *
 *   rumors        the value store, keyed by (tenant, id). `kind`, `pubkey` and
 *                 `created_at` are duplicated out of the JSON so they can be
 *                 indexed and filtered without deserializing.
 *   rumor_tags    the tag index: (tenant, name, value, created_at DESC, id)
 *                 carrying `kind`. The rows ARE the index — a WITHOUT ROWID
 *                 table, so a tag scan reads exactly one b-tree.
 *   rumor_coords  replaceable/addressable coordinates (`kind:pubkey:d`) → the
 *                 id currently stored there, so supersession is one
 *                 primary-key lookup rather than a scan.
 *   rumors_fts    NIP-50 search (see {@link ARMADA_DB_FTS_SCHEMA}), kept in
 *                 step by triggers so no write path can forget it.
 *   kv            the {@link ArmadaKV} store: JSON text by key.
 *
 * `tenant` leads every index and every primary key, so a tenant's rows are
 * contiguous in each b-tree and a query never scans past its own namespace.
 * Every index then ends in `(created_at DESC, id ASC)`, so scanning a prefix
 * yields it newest-first with no sorter and keyset paging is a pure index read
 * — the SQLite equivalent of strfry packing `created_at` into the trailing
 * bytes of an LMDB key.
 *
 * `rumors` is a rowid table (not WITHOUT ROWID) because the FTS5 index is
 * keyed by rowid; (tenant, id) is a UNIQUE index instead of the primary key.
 *
 * REQUIREMENTS: the JSON1 extension (the FTS trigger's `json_extract`) and
 * FTS5. Both are compiled into SQLite-WASM and into `node:sqlite`. A native
 * transport that owns its own file (Android) must be checked against these
 * before this schema is pointed at it, and must mirror the statements.
 */
export const ARMADA_DB_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS rumors (
    tenant TEXT NOT NULL,
    id TEXT NOT NULL,
    kind INTEGER NOT NULL,
    pubkey TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    json TEXT NOT NULL
  )`,
  // The primary-key lookup path: fetching bodies by id, and the uniqueness
  // that makes a re-delivered rumor an `INSERT OR IGNORE` no-op.
  `CREATE UNIQUE INDEX IF NOT EXISTS rumors_id ON rumors (tenant, id)`,
  `CREATE INDEX IF NOT EXISTS rumors_created_at ON rumors (tenant, created_at DESC, id ASC)`,
  `CREATE INDEX IF NOT EXISTS rumors_pubkey ON rumors (tenant, pubkey, created_at DESC, id ASC)`,
  `CREATE INDEX IF NOT EXISTS rumors_kind ON rumors (tenant, kind, created_at DESC, id ASC)`,
  `CREATE INDEX IF NOT EXISTS rumors_pubkey_kind
    ON rumors (tenant, pubkey, kind, created_at DESC, id ASC)`,
  // `kind` rides along as a payload column so `{"#channel": [...], "kinds":
  // [...]}` — the shape of nearly every Armada query — is answered from this
  // b-tree alone.
  `CREATE TABLE IF NOT EXISTS rumor_tags (
    tenant TEXT NOT NULL,
    name TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    id TEXT NOT NULL,
    kind INTEGER NOT NULL,
    PRIMARY KEY (tenant, name, value, created_at DESC, id ASC)
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS rumor_coords (
    tenant TEXT NOT NULL,
    coord TEXT NOT NULL,
    id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (tenant, coord)
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) WITHOUT ROWID`,
];

/**
 * The NIP-50 search index, installed on top of {@link ARMADA_DB_SCHEMA} unless
 * the adapter is constructed with `search: false`.
 *
 * It is kept in step by triggers rather than by the write path, so no writer
 * can forget it — including a second writer (the Android service) that knows
 * nothing about search. That upkeep is the single most expensive thing about a
 * write: measured over 50k rumors on `node:sqlite`, tokenizing and indexing
 * content is ~57% of total write time (6.6s with, 2.8s without), which buys a
 * search two orders of magnitude faster than scanning content.
 *
 * `unicode61` case-folds and strips diacritics, so matching is case- and
 * accent-insensitive. The index spans tenants (rowid is global); the tenant
 * filter is applied when its matches are resolved back to rows.
 */
export const ARMADA_DB_FTS_SCHEMA: readonly string[] = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS rumors_fts
    USING fts5(content, tokenize='unicode61 remove_diacritics 2')`,
  // Rumors are only ever inserted or deleted, never updated, so those are the
  // only two triggers needed. `content` is read back out of the stored JSON,
  // which keeps the rumors table itself unchanged.
  `CREATE TRIGGER IF NOT EXISTS rumors_fts_insert AFTER INSERT ON rumors BEGIN
    INSERT INTO rumors_fts (rowid, content) VALUES (new.rowid, json_extract(new.json, '$.content'));
  END`,
  `CREATE TRIGGER IF NOT EXISTS rumors_fts_delete AFTER DELETE ON rumors BEGIN
    DELETE FROM rumors_fts WHERE rowid = old.rowid;
  END`,
];
