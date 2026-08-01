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
 * REQUIREMENTS: the JSON1 extension (the search trigger's `json_extract`) and
 * FTS5 of at least 3.43 (2023), for contentless tables that support deletion.
 * Android's platform SQLite has neither on the versions Armada supports, which
 * is why [BundledSqlDriver] brings its own engine.
 */
internal object ArmadaDbSchema {

    /** The tables, indexes and triggers every ArmadaDB file has. */
    val BASE: List<String> = listOf(
        // `seq` is the rowid and encodes `created_at`, so the table is stored in
        // time order and needs no separate index to be read newest-first.
        """CREATE TABLE IF NOT EXISTS rumors (
            seq INTEGER PRIMARY KEY,
            tenant TEXT NOT NULL,
            id TEXT NOT NULL,
            kind INTEGER NOT NULL,
            pubkey TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            json TEXT NOT NULL
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
            tenant TEXT NOT NULL,
            coord TEXT NOT NULL,
            id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (tenant, coord)
        ) WITHOUT ROWID""",
        // Tenants, interned to a small integer so a token can name one in a
        // couple of characters. Interning rather than hashing is a correctness
        // decision: two tenants that collided would SHARE posting lists, which
        // is a cross-tenant read, and community ids are partly attacker-chosen.
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
     * Its content is a field of the rumor, so it is maintained entirely by
     * triggers — SQLite reads it out of the stored JSON without a round trip,
     * and no write path can forget it. `unicode61` case-folds and strips
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
            INSERT INTO rumors_fts (rowid, content) VALUES (new.seq, json_extract(new.json, '$.content'));
        END""",
        """CREATE TRIGGER IF NOT EXISTS rumors_fts_delete AFTER DELETE ON rumors BEGIN
            DELETE FROM rumors_fts WHERE rowid = old.seq;
        END""",
    )
}
