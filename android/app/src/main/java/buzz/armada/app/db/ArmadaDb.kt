package buzz.armada.app.db

import android.content.Context

/**
 * The app-wide [SqliteArmadaDb], and the tenant ids both sides of the bridge
 * spell the same way.
 *
 * ONE instance per process, which is the whole point of the native port: the
 * notification service writes what it receives straight into the store, and the
 * WebView reads it back through `ArmadaDbPlugin` — the same connection, the same
 * query planner, no drain format to agree on and no second copy of the data.
 * The service and the WebView are the same process (the service declares no
 * `android:process`), so this really is one connection, guarded by the store's
 * own lock.
 */
object ArmadaDb {

    /**
     * The general event cache: events fetched from relays (profiles, NIP-29
     * timelines, gift wraps, git activity). The WebView's `mainEventStore`.
     */
    const val TENANT_MAIN = "main"

    /**
     * Concord V2 wraps the service could not open (a rekey epoch it holds no
     * key for), parked for the WebView, which does hold the keys. Peek+ack: a
     * wrap is only removed once its rumor is safely in the opened-event store.
     */
    const val TENANT_C2_PARK = "c2park"

    /**
     * The service→WebView handoff queue: the raw events the service ingested,
     * awaiting a pass through wire ingest (which parks wraps, rings scopes and
     * feeds notification candidates). Storing the message is not the same as
     * routing it, so this exists alongside the tenants the content itself lands
     * in. Drained and emptied on open/resume.
     */
    const val TENANT_SERVICE_QUEUE = "svc"

    /** The opened-event store for one Concord V2 community. */
    fun communityTenant(communityIdHex: String): String = "c2:$communityIdHex"

    private const val FILE_NAME = "armada-db.sqlite"

    /** The notification service's retired private event store, deleted on open. */
    private const val LEGACY_FILE_NAME = "armada-events.db"

    @Volatile
    private var instance: SqliteArmadaDb? = null

    /** The database, opened on first use. */
    @JvmStatic
    fun get(context: Context): SqliteArmadaDb {
        instance?.let { return it }
        return synchronized(this) {
            instance ?: open(context).also { instance = it }
        }
    }

    /**
     * Empty every table (logout purge), keeping the file and its schema. The
     * connection stays open: the WebView calls this over the bridge and goes on
     * using the store immediately afterwards.
     */
    @JvmStatic
    fun wipe(context: Context) {
        get(context).wipe()
    }

    private fun open(context: Context): SqliteArmadaDb {
        val app = context.applicationContext

        // The service's old private store, superseded by this one. Its rows were
        // a drain buffer the WebView had already replayed and a flat mirror of
        // events the relays still hold, so nothing here needs migrating — but an
        // upgraded install would otherwise keep the file (and its WAL) forever.
        runCatching { app.deleteDatabase(LEGACY_FILE_NAME) }

        val file = app.getDatabasePath(FILE_NAME)
        file.parentFile?.mkdirs()
        return SqliteArmadaDb(BundledSqlDriver(file.absolutePath))
    }
}
