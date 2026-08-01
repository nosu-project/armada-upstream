package buzz.armada.app.db

/**
 * The SQLite schema behind [SqliteArmadaDb] — a statement-for-statement port of
 * `src/lib/db/sqliteSchema.ts`, which carries the full rationale. The two must
 * stay identical: the WebView and the notification service open the same file,
 * so a divergence here is a divergence in what either can read.
 *
 * The tag index is **an FTS5 inverted index, not a b-tree**. An event's tags are
 * flattened into a string of opaque tokens — `t1:e:<id>`, `t1:channel:<id>` —
 * and handed to FTS5 with a tokenizer configured so each one is a single
 * indivisible token. `{"#channel": [id]}` is then a full-text match for the word
 * `t<ord>:channel:<id>`.
 *
 * Ordering is arranged by construction rather than by a sorter: FTS5 only ever
 * yields rows in rowid order, so the rowid IS time —
 *
 *     seq = created_at × 2²⁰ + a per-second sequence number
 *
 * — which makes `ORDER BY seq DESC` newest-first for the table, for every
 * b-tree over it, and for the index, and turns `since`/`until` into a rowid
 * range FTS5 pushes down into its own backwards walk.
 *
 * REQUIREMENTS: FTS5 of at least 3.43 (2023), for contentless tables that
 * support deletion, and the JSON1 extension (the v0→v1 rebuild's
 * `json_extract`). Android's platform SQLite has neither on the versions Armada
 * supports, which is why [BundledSqlDriver] brings its own engine.
 */
internal object ArmadaDbSchema {

    /**
     * The schema version, stored in `PRAGMA user_version`. A file below it is
     * upgraded before the `CREATE IF NOT EXISTS` statements run.
     *
     *   0  the pre-versioning layout: `rumors.tenant` / `rumor_coords.tenant`
     *      were the tenant id TEXT, and `rumors.json` held the whole serialized
     *      rumor — so the id, kind, pubkey and created_at columns were stored
     *      twice, and the tenant id was repeated in every row of the table and
     *      of its five indexes.
     *   1  the current layout below.
     */
    const val VERSION = 1L

    /** The tables, indexes and triggers every ArmadaDB file has. */
    val BASE: List<String> = listOf(
        // `seq` is the rowid and encodes `created_at`, so the table is stored in
        // time order and needs no separate index to be read newest-first. The
        // six NIP-01 fields are one column each — `tags` as JSON array text —
        // and a read reassembles the rumor from them, so no field is stored
        // twice and nothing a caller adds beyond them is stored at all.
        """CREATE TABLE IF NOT EXISTS rumors (
            seq INTEGER PRIMARY KEY,
            tenant INTEGER NOT NULL,
            id TEXT NOT NULL,
            kind INTEGER NOT NULL,
            pubkey TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            tags TEXT NOT NULL,
            content TEXT NOT NULL
        )""",
        // The lookup path: fetching bodies by id, and the uniqueness that makes
        // a re-delivered rumor a no-op.
        "CREATE UNIQUE INDEX IF NOT EXISTS rumors_id ON rumors (tenant, id)",
        // SQLite appends the rowid to every index entry, and the rowid is time,
        // so these are already `(…, created_at)` indexes — scanned backwards for
        // newest-first with no sorter and no `created_at`/`id` in the key.
        "CREATE INDEX IF NOT EXISTS rumors_tenant ON rumors (tenant)",
        "CREATE INDEX IF NOT EXISTS rumors_kind ON rumors (tenant, kind)",
        "CREATE INDEX IF NOT EXISTS rumors_pubkey ON rumors (tenant, pubkey)",
        "CREATE INDEX IF NOT EXISTS rumors_pubkey_kind ON rumors (tenant, pubkey, kind)",
        // The tag index. `tokenchars ':_'` is what makes a tag token
        // indivisible: without it the tokenizer would split `t1:e:<id>` into
        // three words, and a `#e` filter would match any rumor mentioning that
        // id in any tag at all.
        //
        // `detail=none` strips everything FTS5 keeps for *text*: no positions,
        // no per-column tags, just a delta-encoded list of rowids per token —
        // precisely an inverted index and nothing more. `content=''` drops the
        // copy of the text it would otherwise keep, and `contentless_delete`
        // keeps rows deletable, which a plain contentless table isn't.
        """CREATE VIRTUAL TABLE IF NOT EXISTS rumor_tags_fts USING fts5(
            tokens,
            tokenize = 'ascii tokenchars '':_''',
            content = '',
            contentless_delete = 1,
            detail = none
        )""",
        // Every commit leaves behind a segment, and a query with N terms opens
        // an iterator per term *per segment* — so a store written a rumor at a
        // time, as a sync loop writes, answers a multi-term filter several times
        // slower than the same data bulk-loaded. `automerge` is FTS5's
        // incremental defrag: it folds a little merging into each write.
        "INSERT INTO rumor_tags_fts (rumor_tags_fts, rank) VALUES ('automerge', 2)",
        // The token index can only be kept in step on DELETE this way — its
        // tokens depend on the tag index policy, which lives in code, so inserts
        // are written by the store.
        """CREATE TRIGGER IF NOT EXISTS rumors_tags_delete AFTER DELETE ON rumors BEGIN
            DELETE FROM rumor_tags_fts WHERE rowid = old.seq;
        END""",
        // `seq` rides along so superseding a coordinate needs no second lookup
        // to find the row to delete.
        """CREATE TABLE IF NOT EXISTS rumor_coords (
            tenant INTEGER NOT NULL,
            coord TEXT NOT NULL,
            id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (tenant, coord)
        ) WITHOUT ROWID""",
        // Tenants, interned to a small integer so a token — and every row and
        // index entry that names a tenant — can name one in a couple of bytes.
        // Interning rather than hashing is a correctness decision: two tenants
        // that collided would SHARE posting lists, which is a cross-tenant
        // read, and community ids are partly attacker-chosen.
        """CREATE TABLE IF NOT EXISTS tenants (
            ord INTEGER PRIMARY KEY,
            id TEXT NOT NULL UNIQUE
        )""",
        """CREATE TABLE IF NOT EXISTS kv (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        ) WITHOUT ROWID""",
    )

    /**
     * The NIP-50 search index, installed on top of [BASE].
     *
     * Its content is a column of the rumor row, so it is maintained entirely by
     * triggers — no write path can forget it. `unicode61` case-folds and strips
     * diacritics, so matching is case- and accent-insensitive. The index spans
     * tenants (rowid is global); the tenant filter is applied when its matches
     * are resolved back to rows.
     */
    val SEARCH: List<String> = listOf(
        """CREATE VIRTUAL TABLE IF NOT EXISTS rumors_fts USING fts5(
            content,
            tokenize = 'unicode61 remove_diacritics 2',
            content = '',
            contentless_delete = 1
        )""",
        "INSERT INTO rumors_fts (rumors_fts, rank) VALUES ('automerge', 2)",
        // Rumors are only ever inserted or deleted, never updated, so those are
        // the only two triggers needed.
        """CREATE TRIGGER IF NOT EXISTS rumors_fts_insert AFTER INSERT ON rumors BEGIN
            INSERT INTO rumors_fts (rowid, content) VALUES (new.seq, new.content);
        END""",
        """CREATE TRIGGER IF NOT EXISTS rumors_fts_delete AFTER DELETE ON rumors BEGIN
            DELETE FROM rumors_fts WHERE rowid = old.seq;
        END""",
    )

    /**
     * The v0 → v1 rebuild: split `json` into `tags` + `content` columns and
     * turn the tenant TEXT into the interned `tenants.ord`, in `rumors` and
     * `rumor_coords` both. Run inside one transaction, before the [BASE]
     * statements recreate the indexes and triggers against the new tables.
     *
     * Rowids are preserved, which is what keeps the rebuild away from the FTS
     * tables: their rows are keyed by `seq` and stay valid as-is. Dropping the
     * old tables drops their triggers WITHOUT firing them — SQLite's implicit
     * drop-time DELETE fires no triggers — so no index row is lost with them.
     *
     * The tenant interning inserts are belt and braces: every stored rumor's
     * tenant was interned when it was written, so the joins below should never
     * drop a row — but a row whose tenant somehow wasn't interned would
     * otherwise vanish silently, and `INSERT OR IGNORE` makes that impossible
     * instead.
     */
    val REBUILD_V1: List<String> = listOf(
        "INSERT OR IGNORE INTO tenants (id) SELECT DISTINCT tenant FROM rumors",
        "INSERT OR IGNORE INTO tenants (id) SELECT DISTINCT tenant FROM rumor_coords",
        """CREATE TABLE rumors_v1 (
            seq INTEGER PRIMARY KEY,
            tenant INTEGER NOT NULL,
            id TEXT NOT NULL,
            kind INTEGER NOT NULL,
            pubkey TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            tags TEXT NOT NULL,
            content TEXT NOT NULL
        )""",
        """INSERT INTO rumors_v1 (seq, tenant, id, kind, pubkey, created_at, tags, content)
            SELECT r.seq, t.ord, r.id, r.kind, r.pubkey, r.created_at,
                COALESCE(json_extract(r.json, '${'$'}.tags'), '[]'),
                COALESCE(json_extract(r.json, '${'$'}.content'), '')
            FROM rumors r JOIN tenants t ON t.id = r.tenant""",
        "DROP TABLE rumors",
        "ALTER TABLE rumors_v1 RENAME TO rumors",
        """CREATE TABLE rumor_coords_v1 (
            tenant INTEGER NOT NULL,
            coord TEXT NOT NULL,
            id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (tenant, coord)
        ) WITHOUT ROWID""",
        """INSERT INTO rumor_coords_v1 (tenant, coord, id, seq, created_at)
            SELECT t.ord, c.coord, c.id, c.seq, c.created_at
            FROM rumor_coords c JOIN tenants t ON t.id = c.tenant""",
        "DROP TABLE rumor_coords",
        "ALTER TABLE rumor_coords_v1 RENAME TO rumor_coords",
    )
}
