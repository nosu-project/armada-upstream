/**
 * The SQLite schema behind {@link SqliteArmadaDB} — a port of Nostrify's
 * `NSQLiteFTS` with a `tenant` dimension throughout.
 *
 * The tag index is an FTS5 inverted index: tags become opaque tokens
 * (`t<ord>:channel:<id>`), so a tag filter is one MATCH merged from sorted
 * posting lists, a rumor is one index row regardless of tag count, and results
 * need no DISTINCT. FTS5 yields rowid order, so the rowid encodes time:
 *
 *     seq = created_at × 2²⁰ + a per-second sequence number
 *
 * making `ORDER BY seq DESC` newest-first with no sorter, and every secondary
 * index implicitly `(…, created_at)`. Kinds (few, huge posting lists) and
 * usually authors are tested on fetched rows instead. The tenant ord is folded
 * into every token so posting lists are tenant-exact (`main` dwarfs the rest).
 *
 *   rumors         value store keyed by `seq`; six NIP-01 columns, tenant interned.
 *   rumor_tags_fts one row per rumor: tag tokens plus a `_p:` author token;
 *                  contentless, `detail=none` (a bare inverted index).
 *   tenants        tenant id → small integer.
 *   rumors_fts     NIP-50 content search ({@link ARMADA_DB_FTS_SCHEMA}).
 *   rumor_terms    DERIVED term index (tenant, term, seq) from `TermPolicy`: a
 *                  b-tree so lookups are contiguous time-ordered range walks and
 *                  can be GROUPED (newest rumor per conversation).
 *   rumor_term_tenants
 *                  per-tenant backfill marker with policy generation
 *                  (`SqliteArmadaDB.backfillTerms`).
 *   rumor_coords   replaceable/addressable coordinate → current rumor.
 *   kv             {@link ArmadaKV}: JSON text by key.
 *
 * REQUIRES FTS5 ≥ 3.43 (contentless deletes) and JSON1 (v0→v1 rebuild). Native
 * transports owning their own file must check these and mirror the statements.
 */

/**
 * Schema version in `PRAGMA user_version`; older files upgrade before the
 * `CREATE IF NOT EXISTS` statements run.
 *   0  pre-versioning: tenant TEXT columns, whole rumor in `rumors.json`.
 *   1  tenant-interned layout.
 *   2  adds `rumor_terms` and `rumor_term_tenants` (with generation; see
 *      {@link TenantOpts.termsGeneration}). Creating them empty is the whole
 *      migration — the per-tenant backfill builds the cache.
 */
export const ARMADA_DB_VERSION = 2;

export const ARMADA_DB_SCHEMA: readonly string[] = [
  // `seq` rowid encodes `created_at` (time-ordered storage); `tags` is JSON text.
  `CREATE TABLE IF NOT EXISTS rumors (
    seq INTEGER PRIMARY KEY,
    tenant INTEGER NOT NULL,
    id TEXT NOT NULL,
    kind INTEGER NOT NULL,
    pubkey TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    tags TEXT NOT NULL,
    content TEXT NOT NULL
  )`,
  // Fetch by id, and makes a re-delivered rumor a no-op.
  `CREATE UNIQUE INDEX IF NOT EXISTS rumors_id ON rumors (tenant, id)`,
  // Rowid (time) is appended to every index entry, giving newest-first scans.
  `CREATE INDEX IF NOT EXISTS rumors_tenant ON rumors (tenant)`,
  `CREATE INDEX IF NOT EXISTS rumors_kind ON rumors (tenant, kind)`,
  `CREATE INDEX IF NOT EXISTS rumors_pubkey ON rumors (tenant, pubkey)`,
  `CREATE INDEX IF NOT EXISTS rumors_pubkey_kind ON rumors (tenant, pubkey, kind)`,
  // `tokenchars ':_'` keeps each tag token indivisible (else `#e` would match
  // the id in any tag). `detail=none` + `content=''` = bare inverted index;
  // `contentless_delete` keeps rows deletable.
  `CREATE VIRTUAL TABLE IF NOT EXISTS rumor_tags_fts USING fts5(
    tokens,
    tokenize = 'ascii tokenchars '':_''',
    content = '',
    contentless_delete = 1,
    detail = none
  )`,
  // Minimum automerge: incremental writes leave many segments, slowing
  // multi-term reads; measured free on writes, much faster reads.
  `INSERT INTO rumor_tags_fts (rumor_tags_fts, rank) VALUES ('automerge', 2)`,
  // Delete-only trigger: inserts depend on the JS `indexTags` policy.
  `CREATE TRIGGER IF NOT EXISTS rumors_tags_delete AFTER DELETE ON rumors BEGIN
    DELETE FROM rumor_tags_fts WHERE rowid = old.seq;
  END`,
  // `seq` avoids a second lookup when superseding.
  `CREATE TABLE IF NOT EXISTS rumor_coords (
    tenant INTEGER NOT NULL,
    coord TEXT NOT NULL,
    id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (tenant, coord)
  ) WITHOUT ROWID`,
  // Interned (not hashed) for correctness: colliding tenants would share
  // posting lists, and ids are partly attacker-chosen (`c2:<community id>`).
  `CREATE TABLE IF NOT EXISTS tenants (
    ord INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE
  )`,
  `CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) WITHOUT ROWID`,
  // Derived term index: key ordered by time, so a lookup is one backwards
  // range walk to the limit. WITHOUT ROWID since the key is the whole row.
  `CREATE TABLE IF NOT EXISTS rumor_terms (
    tenant INTEGER NOT NULL,
    term TEXT NOT NULL,
    seq INTEGER NOT NULL,
    PRIMARY KEY (tenant, term, seq)
  ) WITHOUT ROWID`,
  // Deletes go by rumor, so they need their own index.
  `CREATE INDEX IF NOT EXISTS rumor_terms_seq ON rumor_terms (seq)`,
  `CREATE TRIGGER IF NOT EXISTS rumors_terms_delete AFTER DELETE ON rumors BEGIN
    DELETE FROM rumor_terms WHERE seq = old.seq;
  END`,
  // Backfill marker; a generation mismatch means a stale derivation.
  `CREATE TABLE IF NOT EXISTS rumor_term_tenants (
    tenant INTEGER PRIMARY KEY,
    generation INTEGER NOT NULL
  ) WITHOUT ROWID`,
];

/**
 * Drop the term index for an unreleased dev layout (`rumor_term_tenants`
 * without `generation`) that's already at the current version and would make
 * every term read/write throw. Detected by layout, like v0. Safe: terms are a
 * cache, recreated and backfilled. Deletable once no pre-release installs remain.
 */
export const ARMADA_DB_DROP_TERM_INDEX: readonly string[] = [
  `DROP TABLE IF EXISTS rumor_terms`,
  `DROP TABLE IF EXISTS rumor_term_tenants`,
];

/**
 * NIP-50 search index (unless constructed with `search: false`). Separate from
 * the token index to tokenize prose differently (`unicode61`: case- and
 * accent-insensitive). Maintained by triggers so no writer (incl. the Android
 * service) can skip it; ~half of write time, for search ~100× faster than
 * scanning. Spans tenants; tenant filtering happens on resolve.
 */
export const ARMADA_DB_FTS_SCHEMA: readonly string[] = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS rumors_fts USING fts5(
    content,
    tokenize = 'unicode61 remove_diacritics 2',
    content = '',
    contentless_delete = 1
  )`,
  `INSERT INTO rumors_fts (rumors_fts, rank) VALUES ('automerge', 2)`,
  // Rumors are only inserted or deleted, never updated.
  `CREATE TRIGGER IF NOT EXISTS rumors_fts_insert AFTER INSERT ON rumors BEGIN
    INSERT INTO rumors_fts (rowid, content) VALUES (new.seq, new.content);
  END`,
  `CREATE TRIGGER IF NOT EXISTS rumors_fts_delete AFTER DELETE ON rumors BEGIN
    DELETE FROM rumors_fts WHERE rowid = old.seq;
  END`,
];

/**
 * v0 → v1 rebuild in one transaction: split `json` into columns and intern
 * tenants, before {@link ARMADA_DB_SCHEMA} recreates indexes/triggers. Rowids
 * are preserved so FTS rows stay valid; dropping tables fires no triggers.
 * `INSERT OR IGNORE` interning ensures the joins can't silently drop rows.
 */
export const ARMADA_DB_REBUILD_V1: readonly string[] = [
  `INSERT OR IGNORE INTO tenants (id) SELECT DISTINCT tenant FROM rumors`,
  `INSERT OR IGNORE INTO tenants (id) SELECT DISTINCT tenant FROM rumor_coords`,
  `CREATE TABLE rumors_v1 (
    seq INTEGER PRIMARY KEY,
    tenant INTEGER NOT NULL,
    id TEXT NOT NULL,
    kind INTEGER NOT NULL,
    pubkey TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    tags TEXT NOT NULL,
    content TEXT NOT NULL
  )`,
  `INSERT INTO rumors_v1 (seq, tenant, id, kind, pubkey, created_at, tags, content)
    SELECT r.seq, t.ord, r.id, r.kind, r.pubkey, r.created_at,
      COALESCE(json_extract(r.json, '$.tags'), '[]'),
      COALESCE(json_extract(r.json, '$.content'), '')
    FROM rumors r JOIN tenants t ON t.id = r.tenant`,
  `DROP TABLE rumors`,
  `ALTER TABLE rumors_v1 RENAME TO rumors`,
  `CREATE TABLE rumor_coords_v1 (
    tenant INTEGER NOT NULL,
    coord TEXT NOT NULL,
    id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (tenant, coord)
  ) WITHOUT ROWID`,
  `INSERT INTO rumor_coords_v1 (tenant, coord, id, seq, created_at)
    SELECT t.ord, c.coord, c.id, c.seq, c.created_at
    FROM rumor_coords c JOIN tenants t ON t.id = c.tenant`,
  `DROP TABLE rumor_coords`,
  `ALTER TABLE rumor_coords_v1 RENAME TO rumor_coords`,
];
