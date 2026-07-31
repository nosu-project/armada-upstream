/**
 * The SQLite schema behind {@link SqliteArmadaDB}. One database holds every
 * tenant plus the KV store, so the adapter needs exactly one connection
 * (one OPFS file on web/Electron, one shared file on Android).
 *
 * Design notes:
 *  - `tenant` is the leading column of every index, so a tenant-scoped query
 *    is an index range scan, not a filter over the whole table. Uniqueness is
 *    `(tenant, id)`: the same rumor may legitimately exist in two tenants
 *    (a message quoted across communities) and they don't share a row.
 *  - `seq` is AUTOINCREMENT so it stays strictly monotonic across deletes —
 *    a drain cursor ("everything after N") can be added without a migration.
 *  - `d` is the d-tag for addressable kinds (30000–39999) and '' otherwise,
 *    making supersession and NIP-09 `a`-tag deletion a single indexed
 *    coordinate lookup (tenant, pubkey, kind, d).
 *  - `content` is denormalized out of `raw` so `search` filters need no JSON1
 *    (not guaranteed on older Android framework SQLite).
 *  - `rumor_tags` is keyed (tenant, event_id, name, value) WITHOUT ROWID:
 *    inserts are idempotent via INSERT OR IGNORE, and (tenant, name, value)
 *    is indexed for `#x` filters.
 *  - `raw` is the rumor JSON — no `sig` field, ever.
 */
export const ARMADA_DB_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS rumors (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant TEXT NOT NULL,
    id TEXT NOT NULL,
    pubkey TEXT NOT NULL,
    kind INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    d TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    raw TEXT NOT NULL,
    UNIQUE (tenant, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_rumors_pubkey_kind ON rumors (tenant, pubkey, kind, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_rumors_kind ON rumors (tenant, kind, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_rumors_pubkey ON rumors (tenant, pubkey, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_rumors_created ON rumors (tenant, created_at)`,
  `CREATE TABLE IF NOT EXISTS rumor_tags (
    tenant TEXT NOT NULL,
    event_id TEXT NOT NULL,
    name TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (tenant, event_id, name, value)
  ) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS idx_rumor_tags_name_value ON rumor_tags (tenant, name, value)`,
  `CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) WITHOUT ROWID`,
];
