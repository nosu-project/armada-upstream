package pub.armada.app;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * The shared Nostr event database — ONE file used by both sides of the app:
 *
 *  - {@link NotificationRelayService} writes every event it receives (and
 *    every kind-0 profile it fetches) here, so the WebView finds them without
 *    a relay round-trip, and the notification drain is durable (a `seq`
 *    cursor instead of the old in-memory 200-event buffer).
 *  - The WebView's event store runs its whole NIP-01 filter engine against
 *    this same file through {@link ArmadaNotificationPlugin#dbRun} /
 *    {@link ArmadaNotificationPlugin#dbQuery} — so profiles fetched by either
 *    side are stored ONCE and visible to both.
 *
 * Schema and statement shapes are MIRRORED from the TypeScript side
 * (src/lib/sqlite/schema.ts and SqliteEventStore.ts) — any change must be
 * made in both places. All supersession logic is guarded SQL (no
 * read-modify-write), so the two writers can't race each other into a stale
 * replaceable version.
 */
final class SharedEventDb extends SQLiteOpenHelper {

    private static final String DB_NAME = "armada-events.db";
    private static final int DB_VERSION = 1;

    /** Writer tags: rows the drain replays vs the WebView's own writes. */
    static final String SRC_SERVICE = "svc";

    private static SharedEventDb instance;

    static synchronized SharedEventDb get(Context context) {
        if (instance == null) {
            instance = new SharedEventDb(context.getApplicationContext());
        }
        return instance;
    }

    private SharedEventDb(Context context) {
        super(context, DB_NAME, null, DB_VERSION);
        // WAL: the service (its handler thread) and the plugin (Capacitor
        // threads) read/write concurrently within this one process.
        setWriteAheadLoggingEnabled(true);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        // Mirrors EVENT_DB_SCHEMA in src/lib/sqlite/schema.ts.
        db.execSQL("CREATE TABLE IF NOT EXISTS events ("
                + "seq INTEGER PRIMARY KEY AUTOINCREMENT,"
                + "id TEXT NOT NULL UNIQUE,"
                + "pubkey TEXT NOT NULL,"
                + "kind INTEGER NOT NULL,"
                + "created_at INTEGER NOT NULL,"
                + "d TEXT NOT NULL DEFAULT '',"
                + "content TEXT NOT NULL DEFAULT '',"
                + "raw TEXT NOT NULL,"
                + "src TEXT NOT NULL DEFAULT 'web')");
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_events_pubkey_kind ON events (pubkey, kind, created_at)");
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_events_kind ON events (kind, created_at)");
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_events_pubkey ON events (pubkey, created_at)");
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_events_created ON events (created_at)");
        db.execSQL("CREATE TABLE IF NOT EXISTS tags ("
                + "event_id TEXT NOT NULL,"
                + "name TEXT NOT NULL,"
                + "value TEXT NOT NULL,"
                + "PRIMARY KEY (event_id, name, value)) WITHOUT ROWID");
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_tags_name_value ON tags (name, value)");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        // v1 — nothing to migrate yet.
    }

    // ── Service write path ───────────────────────────────────────────────────

    /**
     * Insert one event with full store semantics (mirrors
     * SqliteEventStore.insertStatements): ephemeral kinds are skipped,
     * replaceable/addressable events supersede older versions at the same
     * (pubkey, kind, d) coordinate — and a stale write is skipped — and
     * single-letter tags (< 200 chars) are indexed. Duplicates are no-ops.
     */
    void insertEvent(JSONObject ev, String src) {
        String id = ev.optString("id");
        String pubkey = ev.optString("pubkey");
        int kind = ev.optInt("kind", -1);
        long createdAt = ev.optLong("created_at", 0);
        if (id.isEmpty() || pubkey.isEmpty() || kind < 0) return;
        if (kind >= 20000 && kind < 30000) return; // ephemeral — never stored

        boolean addressable = kind >= 30000 && kind < 40000;
        boolean replaceable = addressable || kind == 0 || kind == 3
                || (kind >= 10000 && kind < 20000);
        String d = addressable ? tagValue(ev, "d") : "";
        String content = ev.optString("content", "");
        String raw = ev.toString();

        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            if (replaceable) {
                db.execSQL("INSERT OR IGNORE INTO events (id, pubkey, kind, created_at, d, content, raw, src)"
                                + " SELECT ?, ?, ?, ?, ?, ?, ?, ?"
                                + " WHERE NOT EXISTS (SELECT 1 FROM events"
                                + " WHERE pubkey = ? AND kind = ? AND d = ?"
                                + " AND (created_at > ? OR (created_at = ? AND id < ?)))",
                        new Object[]{id, pubkey, kind, createdAt, d, content, raw, src,
                                pubkey, kind, d, createdAt, createdAt, id});
                db.execSQL("DELETE FROM tags WHERE event_id IN ("
                                + "SELECT id FROM events WHERE pubkey = ? AND kind = ? AND d = ? AND id <> ?)"
                                + " AND EXISTS (SELECT 1 FROM events WHERE id = ?)",
                        new Object[]{pubkey, kind, d, id, id});
                db.execSQL("DELETE FROM events WHERE pubkey = ? AND kind = ? AND d = ? AND id <> ?"
                                + " AND EXISTS (SELECT 1 FROM events WHERE id = ?)",
                        new Object[]{pubkey, kind, d, id, id});
            } else {
                db.execSQL("INSERT OR IGNORE INTO events (id, pubkey, kind, created_at, d, content, raw, src)"
                                + " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                        new Object[]{id, pubkey, kind, createdAt, d, content, raw, src});
            }
            // Indexed tags, guarded on the event row existing (a superseded
            // write must not leave orphan tag rows).
            JSONArray tags = ev.optJSONArray("tags");
            if (tags != null) {
                Set<String> seen = new HashSet<>();
                for (int i = 0; i < tags.length(); i++) {
                    JSONArray tag = tags.optJSONArray(i);
                    if (tag == null || tag.length() < 2) continue;
                    String name = tag.optString(0);
                    String value = tag.optString(1);
                    if (name.length() != 1 || value.isEmpty() || value.length() >= 200) continue;
                    if (!seen.add(name + " " + value)) continue;
                    db.execSQL("INSERT OR IGNORE INTO tags (event_id, name, value)"
                                    + " SELECT id, ?, ? FROM events WHERE id = ?",
                            new Object[]{name, value, id});
                }
            }
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    // ── Service read path ────────────────────────────────────────────────────

    /**
     * The stored kind-0 for a pubkey (supersession keeps only the newest),
     * or null. This is how the service reuses profiles the WEBVIEW fetched —
     * the reason a profile is now stored (and fetched) once, not twice.
     */
    String getProfileRaw(String pubkey) {
        SQLiteDatabase db = getReadableDatabase();
        try (Cursor c = db.rawQuery(
                "SELECT raw FROM events WHERE kind = 0 AND pubkey = ? LIMIT 1",
                new String[]{pubkey})) {
            return c.moveToFirst() ? c.getString(0) : null;
        }
    }

    /** One drained row: monotonic seq + the raw event JSON. */
    static final class DrainRow {
        final long seq;
        final String raw;
        DrainRow(long seq, String raw) {
            this.seq = seq;
            this.raw = raw;
        }
    }

    /**
     * A page of service-received rows after {@code cursor}, oldest first.
     * `seq` is AUTOINCREMENT (strictly monotonic even across deletes), so the
     * acked cursor never skips or replays beyond the acked page.
     */
    List<DrainRow> drainSince(long cursor, int limit) {
        List<DrainRow> rows = new ArrayList<>();
        SQLiteDatabase db = getReadableDatabase();
        try (Cursor c = db.rawQuery(
                "SELECT seq, raw FROM events WHERE seq > ? AND src = ? ORDER BY seq ASC LIMIT " + limit,
                new String[]{String.valueOf(cursor), SRC_SERVICE})) {
            while (c.moveToNext()) {
                rows.add(new DrainRow(c.getLong(0), c.getString(1)));
            }
        }
        return rows;
    }

    // ── WebView bridge (the JS store's SqlDriver transport) ──────────────────

    /**
     * Execute the JS store's statements atomically. Statement shapes come
     * from SqliteEventStore.ts; params are String/Number/null.
     */
    void runBatch(JSONArray statements) throws JSONException {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            for (int i = 0; i < statements.length(); i++) {
                JSONObject stmt = statements.getJSONObject(i);
                String sql = stmt.getString("sql");
                JSONArray params = stmt.optJSONArray("params");
                if (params == null || params.length() == 0) {
                    db.execSQL(sql);
                } else {
                    Object[] args = new Object[params.length()];
                    for (int p = 0; p < params.length(); p++) {
                        Object v = params.get(p);
                        args[p] = v == JSONObject.NULL ? null : v;
                    }
                    db.execSQL(sql, args);
                }
            }
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    /**
     * Run one SELECT for the JS store; rows come back as positional value
     * arrays. rawQuery binds args as TEXT — SQLite's column affinity converts
     * them back for INTEGER comparisons (verified against real SQLite in
     * SqliteEventStore.test.ts's node driver, which exercises the same SQL).
     */
    JSONArray queryRows(String sql, JSONArray params) throws JSONException {
        String[] args = null;
        if (params != null && params.length() > 0) {
            args = new String[params.length()];
            for (int i = 0; i < params.length(); i++) {
                Object v = params.get(i);
                args[i] = v == JSONObject.NULL ? null : String.valueOf(v);
            }
        }
        JSONArray rows = new JSONArray();
        SQLiteDatabase db = getReadableDatabase();
        try (Cursor c = db.rawQuery(sql, args)) {
            while (c.moveToNext()) {
                JSONArray row = new JSONArray();
                for (int i = 0; i < c.getColumnCount(); i++) {
                    switch (c.getType(i)) {
                        case Cursor.FIELD_TYPE_INTEGER:
                            row.put(c.getLong(i));
                            break;
                        case Cursor.FIELD_TYPE_FLOAT:
                            row.put(c.getDouble(i));
                            break;
                        case Cursor.FIELD_TYPE_NULL:
                            row.put(JSONObject.NULL);
                            break;
                        default:
                            row.put(c.getString(i));
                            break;
                    }
                }
                rows.put(row);
            }
        }
        return rows;
    }

    private static String tagValue(JSONObject ev, String name) {
        JSONArray tags = ev.optJSONArray("tags");
        if (tags == null) return "";
        for (int i = 0; i < tags.length(); i++) {
            JSONArray tag = tags.optJSONArray(i);
            if (tag != null && tag.length() >= 2 && name.equals(tag.optString(0))) {
                return tag.optString(1);
            }
        }
        return "";
    }
}
