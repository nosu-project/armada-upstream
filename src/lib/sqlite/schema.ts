/**
 * Shared SQLite schema for the Armada event store ("one database, three
 * transports"): the SAME table shapes are created by the WASM worker (web /
 * Electron, OPFS-backed) and by the Android native side (SharedEventDb.java,
 * where the file is shared with NotificationRelayService). Any change here
 * MUST be mirrored in SharedEventDb.java.
 *
 * Design notes:
 *  - `seq` is AUTOINCREMENT so it is strictly monotonic even across deletes —
 *    the Android drain cursor ("give me service-received events after N")
 *    depends on that.
 *  - `d` is the d-tag for addressable kinds (30000–39999) and '' otherwise,
 *    so replaceable/addressable supersession and NIP-09 `a`-tag deletions are
 *    a single indexed coordinate lookup (pubkey, kind, d).
 *  - `content` is denormalized out of `raw` so NIP-50 `search` filters don't
 *    need JSON1 (not guaranteed on older Android framework SQLite).
 *  - `src` records the writer ('svc' = native service, 'web' = webview). The
 *    Android drain replays only src='svc' rows, so the webview never gets its
 *    own writes echoed back.
 *  - `tags` is keyed (event_id, name, value) WITHOUT ROWID: inserts are
 *    idempotent via INSERT OR IGNORE, and (name, value) is indexed for
 *    `#x` tag filters.
 */
export const EVENT_DB_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    pubkey TEXT NOT NULL,
    kind INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    d TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    raw TEXT NOT NULL,
    src TEXT NOT NULL DEFAULT 'web'
  )`,
  `CREATE INDEX IF NOT EXISTS idx_events_pubkey_kind ON events (pubkey, kind, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_events_kind ON events (kind, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_events_pubkey ON events (pubkey, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_events_created ON events (created_at)`,
  `CREATE TABLE IF NOT EXISTS tags (
    event_id TEXT NOT NULL,
    name TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (event_id, name, value)
  ) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS idx_tags_name_value ON tags (name, value)`,
];
