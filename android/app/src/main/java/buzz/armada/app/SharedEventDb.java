package buzz.armada.app;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * The background service's Nostr event database.
 *
 * {@link NotificationRelayService} writes every event it receives (and every
 * kind-0 profile it fetches) here, which makes the notification drain durable
 * (a `seq` cursor instead of the old in-memory 200-event buffer) and lets the
 * service reuse a profile it already fetched instead of re-fetching it.
 *
 * The WebView no longer shares this file. It used to run its whole NIP-01
 * filter engine against it over a plugin SQL bridge; its store is now ArmadaDB
 * (src/lib/db), so the only path out of here is
 * {@link ArmadaNotificationPlugin#drainEvents}. All supersession logic is
 * guarded SQL (no read-modify-write), so concurrent writers can't race each
 * other into a stale replaceable version.
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
     * Whether an event id is already stored. Used as the durable
     * notification-dedupe floor for DM gift wraps, which have no usable
     * timestamp for since-gating.
     */
    boolean hasEvent(String id) {
        if (id == null || id.isEmpty()) return false;
        try (Cursor c = getReadableDatabase().rawQuery(
                "SELECT 1 FROM events WHERE id = ? LIMIT 1", new String[]{id})) {
            return c.moveToFirst();
        }
    }

    /**
     * Insert one event with full store semantics: ephemeral kinds are skipped,
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
     * or null — so a profile the service already fetched is not fetched again.
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
