/**
 * The SQLite schema behind {@link SqliteArmadaDB} — a port of Nostrify's
 * `NSQLiteFTS`, with a `tenant` dimension threaded through every table and
 * every index term.
 *
 * The tag index is **an FTS5 inverted index, not a b-tree**. An event's tags
 * are flattened into a string of opaque tokens — `t1:e:<id>`,
 * `t1:channel:<id>` — and handed to FTS5 with a tokenizer configured so each
 * one is a single indivisible token. `{"#channel": [id]}` is then a full-text
 * match for the word `t<ord>:channel:<id>`.
 *
 * The bet, measured against the b-tree design this replaces:
 *
 *  - A tag filter is a boolean expression over terms, which is exactly what an
 *    FTS5 query *is*. `{"#channel": [c], "#reply": [r]}` is one MATCH, merged
 *    from sorted posting lists in C. The b-tree design could drive on only one
 *    term and had to intersect the rest in JavaScript.
 *  - Posting lists are delta-encoded varints, so an indexed tag costs a byte
 *    or two per rumor rather than a whole b-tree row. A rumor with 300 tags is
 *    one insert of one row, not 300 index inserts.
 *  - One rumor is one row of the index, so a filter matching a rumor through
 *    several of its tags yields it once — no DISTINCT, no de-duplication.
 *
 * The catch is ordering: Nostr wants newest-first with a small limit, and FTS5
 * only ever yields rows in rowid order. That is fine *if* rowid order is time
 * order, which is arranged by construction:
 *
 *     seq = created_at × 2²⁰ + a per-second sequence number
 *
 * so `ORDER BY seq DESC` is `ORDER BY created_at DESC`, walked backwards with
 * no sorter, and `since`/`until` become a rowid range FTS5 pushes down into
 * that walk. The same encoding pays off outside the index: `rumors` is
 * *clustered* by time, and since SQLite appends the rowid to every index
 * entry, `(tenant)`, `(tenant, kind)` and `(tenant, pubkey)` are already
 * `(…, created_at)` indexes — narrower keys than spelling `created_at DESC,
 * id ASC` out, as the b-tree design had to.
 *
 * What the index does *not* carry is as deliberate as what it does. A posting
 * list is only worth intersecting when it is short, and in descending order
 * FTS5 reads a term's list in full — so a term matching a large share of the
 * store costs its whole length however small the answer. Kinds are exactly
 * that kind of term (there are only a handful in use), so kinds — and authors,
 * unless a tag is already driving — are tested on the `rumors` rows the index
 * finds, which costs a column read on a row that was going to be fetched
 * anyway.
 *
 * The tenant is the one constraint that goes the *other* way. It is the
 * primary partition of this database: a query must never scan past its own
 * namespace, and `main` (the relay cache) will dwarf every community tenant
 * while sharing `p` and `e` tag values with all of them. So the tenant is
 * folded into the tokens themselves — every token is `t<ord>:<name>:<value>`,
 * where `ord` is the tenant's row in `tenants` — which makes each posting list
 * tenant-exact, rather than being one more enormous list to intersect or a
 * condition that discards rows after the fact.
 *
 *   rumors         the value store, keyed by the time-encoded `seq` rowid. A
 *                  rumor is its six NIP-01 fields, one column each — nothing
 *                  is stored twice, and a read reassembles the rumor from the
 *                  row. `tenant` is the interned `tenants.ord`, so the ~50-byte
 *                  tenant id isn't repeated per row and per index entry.
 *   rumor_tags_fts one row per rumor: its tag tokens, plus a `_p:` token for
 *                  its author so a filter naming both a tag and an author is
 *                  still one index lookup. Contentless and `detail=none`,
 *                  which reduces FTS5 to a bare inverted index — no positions,
 *                  no column tags, no copy of the text.
 *   tenants        tenant id → the small integer the other tables and the
 *                  index tokens name it by.
 *   rumors_fts     NIP-50 search over `content` (see
 *                  {@link ARMADA_DB_FTS_SCHEMA}), tokenized for prose.
 *   rumor_terms    the DERIVED term index: one row per (tenant, term, rumor),
 *                  written from the tenant's `TermPolicy`. A b-tree rather
 *                  than more tokens in `rumor_tags_fts`, for two reasons —
 *                  `(tenant, term, seq)` puts a term's rumors in one
 *                  contiguous, already-time-ordered range, so a lookup is a
 *                  backwards walk with an exact `LIMIT` and no posting-list
 *                  merge; and being an ordinary table it can be GROUPED, which
 *                  is how "the newest rumor of every conversation" stops being
 *                  a scan of the tenant.
 *   rumor_term_tenants
 *                  which tenants' existing rows have been indexed by their
 *                  policy — the marker that makes the backfill run once. See
 *                  `SqliteArmadaDB.backfillTerms`.
 *   rumor_coords   replaceable/addressable coordinates (`kind:pubkey:d`) → the
 *                  rumor currently stored there, so supersession is one
 *                  primary-key lookup rather than a scan.
 *   kv             the {@link ArmadaKV} store: JSON text by key.
 *
 * REQUIREMENTS: FTS5 of at least 3.43 (2023), for contentless tables that
 * support deletion, and the JSON1 extension (the v0→v1 rebuild's
 * `json_extract`). Both hold for SQLite-WASM and `node:sqlite`. A native
 * transport that owns its own file (Android) must be checked against these
 * before this schema is pointed at it, and must mirror the statements.
 */

/**
 * The schema version, stored in `PRAGMA user_version`. A file below it is
 * upgraded before the `CREATE IF NOT EXISTS` statements run.
 *
 *   0  the pre-versioning layout: `rumors.tenant` / `rumor_coords.tenant` were
 *      the tenant id TEXT, and `rumors.json` held the whole serialized rumor —
 *      so the id, kind, pubkey and created_at columns were stored twice, and
 *      the tenant id was repeated in every row of the table and of its five
 *      indexes.
 *   1  the tenant-interned layout, without a term index.
 *   2  the current layout below: adds `rumor_terms` and
 *      `rumor_term_tenants`. There is no rebuild — the new tables are empty
 *      and a `CREATE IF NOT EXISTS` installs them — because a term cannot be
 *      derived in SQL. Rows written before it are indexed by the per-tenant
 *      backfill instead, which is gated on `rumor_term_tenants` and so is
 *      indifferent to which version the file arrived at it from.
 */
export const ARMADA_DB_VERSION = 2;

export const ARMADA_DB_SCHEMA: readonly string[] = [
  // `seq` is the rowid and encodes `created_at`, so the table is stored in
  // time order and needs no separate index to be read newest-first. The six
  // NIP-01 fields are one column each — `tags` as JSON array text — and a read
  // reassembles the rumor from them, so no field is stored twice and nothing a
  // caller adds beyond them is stored at all.
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
  // The lookup path: fetching bodies by id, and the uniqueness that makes a
  // re-delivered rumor a no-op.
  `CREATE UNIQUE INDEX IF NOT EXISTS rumors_id ON rumors (tenant, id)`,
  // SQLite appends the rowid to every index entry, and the rowid is time, so
  // these are already `(…, created_at)` indexes — scanned backwards for
  // newest-first with no sorter and no `created_at`/`id` in the key.
  `CREATE INDEX IF NOT EXISTS rumors_tenant ON rumors (tenant)`,
  `CREATE INDEX IF NOT EXISTS rumors_kind ON rumors (tenant, kind)`,
  `CREATE INDEX IF NOT EXISTS rumors_pubkey ON rumors (tenant, pubkey)`,
  `CREATE INDEX IF NOT EXISTS rumors_pubkey_kind ON rumors (tenant, pubkey, kind)`,
  // The tag index. `tokenchars ':_'` is what makes a tag token indivisible:
  // without it the tokenizer would split `t1:e:<id>` into three words, and a
  // `#e` filter would match any rumor mentioning that id in any tag at all.
  //
  // `detail=none` strips everything FTS5 keeps for *text*: no positions, no
  // per-column tags, just a delta-encoded list of rowids per token — precisely
  // an inverted index and nothing more. `content=''` drops the copy of the
  // text it would otherwise keep, and `contentless_delete` keeps rows
  // deletable, which a plain contentless table isn't.
  `CREATE VIRTUAL TABLE IF NOT EXISTS rumor_tags_fts USING fts5(
    tokens,
    tokenize = 'ascii tokenchars '':_''',
    content = '',
    contentless_delete = 1,
    detail = none
  )`,
  // Every commit leaves behind a segment, and a query with N terms opens an
  // iterator per term *per segment* — so a store written a rumor at a time, as
  // a sync loop writes, answers a multi-term filter several times slower than
  // the same data bulk-loaded. `automerge` is FTS5's incremental defrag: it
  // folds a little merging into each write. Turning it down from the default 4
  // to its minimum measured free on the write side and several times faster on
  // many-term reads, which is the trade this store wants.
  `INSERT INTO rumor_tags_fts (rumor_tags_fts, rank) VALUES ('automerge', 2)`,
  // The token index can only be kept in step on DELETE this way — its tokens
  // depend on the `indexTags` policy, which lives in JavaScript, so inserts
  // are written by the adapter.
  `CREATE TRIGGER IF NOT EXISTS rumors_tags_delete AFTER DELETE ON rumors BEGIN
    DELETE FROM rumor_tags_fts WHERE rowid = old.seq;
  END`,
  // `seq` rides along so superseding a coordinate needs no second lookup to
  // find the row to delete.
  `CREATE TABLE IF NOT EXISTS rumor_coords (
    tenant INTEGER NOT NULL,
    coord TEXT NOT NULL,
    id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (tenant, coord)
  ) WITHOUT ROWID`,
  // Tenants, interned to a small integer so a token — and now every row and
  // index entry that names a tenant — can name one in a couple of bytes. `ord`
  // is the rowid, so it is allocated by the insert.
  //
  // Interning rather than hashing the tenant id is a correctness decision, not
  // a size one: two tenants that collided would SHARE posting lists, which is
  // a cross-tenant read. A truncated hash makes that a birthday problem over
  // ids that are partly attacker-chosen (`c2:<community id>`), and a full hash
  // would put 64 characters in front of every token. An integer from the
  // database can't collide at all.
  `CREATE TABLE IF NOT EXISTS tenants (
    ord INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE
  )`,
  `CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) WITHOUT ROWID`,
  // The derived term index. `seq` is the rumor's rowid and encodes time, so
  // the primary key's third column orders each term's rumors newest-last —
  // read backwards, a term lookup is one contiguous range walk that stops at
  // the limit, with no sorter and no bodies touched until the join.
  //
  // WITHOUT ROWID because the key IS the whole row: an ordinary table would
  // store the same three columns again in an index beside it.
  `CREATE TABLE IF NOT EXISTS rumor_terms (
    tenant INTEGER NOT NULL,
    term TEXT NOT NULL,
    seq INTEGER NOT NULL,
    PRIMARY KEY (tenant, term, seq)
  ) WITHOUT ROWID`,
  // The delete path goes the other way — by rumor, not by term — and has no
  // term to seek with, so it needs an index of its own or every deletion
  // scans the table.
  `CREATE INDEX IF NOT EXISTS rumor_terms_seq ON rumor_terms (seq)`,
  `CREATE TRIGGER IF NOT EXISTS rumors_terms_delete AFTER DELETE ON rumors BEGIN
    DELETE FROM rumor_terms WHERE seq = old.seq;
  END`,
  // Which tenants' pre-existing rows have been through their policy. A row
  // here means the backfill is done and reads need not wait for it again.
  `CREATE TABLE IF NOT EXISTS rumor_term_tenants (
    tenant INTEGER PRIMARY KEY
  ) WITHOUT ROWID`,
];

/**
 * The NIP-50 search index, installed on top of {@link ARMADA_DB_SCHEMA} unless
 * the adapter is constructed with `search: false`.
 *
 * Kept in a table of its own rather than as a column of the token index, so
 * the two can be tokenized on their own terms: prose wants case folding,
 * diacritic stripping and positions for phrases, none of which a tag token has
 * any use for.
 *
 * Its content is a column of the rumor row, so it is maintained entirely by
 * triggers — no write path can forget it, including a second writer (the
 * Android service) that knows nothing about search. That upkeep is the single
 * most expensive thing about a write: measured over 50k rumors, tokenizing and
 * indexing content is roughly half of total write time, which buys a search
 * two orders of magnitude faster than scanning content.
 *
 * `unicode61` case-folds and strips diacritics, so matching is case- and
 * accent-insensitive. The index spans tenants (rowid is global); the tenant
 * filter is applied when its matches are resolved back to rows.
 */
export const ARMADA_DB_FTS_SCHEMA: readonly string[] = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS rumors_fts USING fts5(
    content,
    tokenize = 'unicode61 remove_diacritics 2',
    content = '',
    contentless_delete = 1
  )`,
  `INSERT INTO rumors_fts (rumors_fts, rank) VALUES ('automerge', 2)`,
  // Rumors are only ever inserted or deleted, never updated, so those are the
  // only two triggers needed.
  `CREATE TRIGGER IF NOT EXISTS rumors_fts_insert AFTER INSERT ON rumors BEGIN
    INSERT INTO rumors_fts (rowid, content) VALUES (new.seq, new.content);
  END`,
  `CREATE TRIGGER IF NOT EXISTS rumors_fts_delete AFTER DELETE ON rumors BEGIN
    DELETE FROM rumors_fts WHERE rowid = old.seq;
  END`,
];

/**
 * The v0 → v1 rebuild: split `json` into `tags` + `content` columns and turn
 * the tenant TEXT into the interned `tenants.ord`, in `rumors` and
 * `rumor_coords` both. Run inside one transaction, before the
 * {@link ARMADA_DB_SCHEMA} statements recreate the indexes and triggers
 * against the new tables.
 *
 * Rowids are preserved, which is what keeps the rebuild away from the FTS
 * tables: their rows are keyed by `seq` and stay valid as-is. Dropping the old
 * tables drops their triggers WITHOUT firing them — SQLite's implicit
 * drop-time DELETE fires no triggers — so no index row is lost with them.
 *
 * The tenant interning inserts are belt and braces: every stored rumor's
 * tenant was interned when it was written, so the joins below should never
 * drop a row — but a row whose tenant somehow wasn't interned would otherwise
 * vanish silently, and `INSERT OR IGNORE` makes that impossible instead.
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
