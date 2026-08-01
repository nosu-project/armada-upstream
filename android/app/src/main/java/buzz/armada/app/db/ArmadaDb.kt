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
     * The general event cache: events whose meaning doesn't depend on who served
     * them (profiles, git activity, gift wraps, sealed Concord outers). The
     * WebView's `mainEventStore`.
     *
     * NIP-29 is deliberately NOT here — see [nip29Tenant].
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
     *
     * Retired in favour of [serviceQueueTenant]'s per-relay queues, and kept only
     * so a queue written by the previous build still drains. Never written now.
     */
    const val TENANT_SERVICE_QUEUE = "svc"

    /** Prefix of the per-relay queues [serviceQueueTenant] hands out. */
    const val TENANT_SERVICE_QUEUE_PREFIX = "svc:"

    /**
     * One relay's NIP-29 data. MUST match `nip29Tenant()` in
     * `src/lib/db/relayScope.ts`, which is the tenant the WebView reads.
     *
     * A NIP-29 group is named by an `h`/`d` value that means nothing on its own:
     * the same id on two relays is two unrelated groups, and relay software that
     * ships a SHARED signing identity (zooid) defeats scoping by author too. So
     * the relay goes in the tenant id and the isolation is structural.
     *
     * `relayUrl` is expected ALREADY NORMALIZED, because it is the URL the
     * WebView configured this service with (`useNativeNotifications` runs every
     * relay through `normalizeRelayUrl` before `configure`). Normalization stays
     * a JS-side concern on purpose: a second implementation here is a second
     * spelling waiting to happen, and a tenant spelled differently by the two
     * writers would strand every message the service received while the app was
     * dead. Only a trailing slash is trimmed, so the id is stable if a caller
     * hands over a URL that skipped the JS path.
     */
    @JvmStatic
    fun nip29Tenant(relayUrl: String): String = "nip29:${relayUrl.trimEnd('/')}"

    /**
     * The handoff queue for one relay, or the unscoped queue when the relay is
     * unknown.
     *
     * Per relay because a drained page has to say which relay it came from: the
     * WebView routes NIP-29 events into [nip29Tenant], and a rumor carries no
     * record of its source relay — nor may one be injected into its tags, which
     * are the bytes its id commits to and would make the fact forgeable by any
     * sender that spelled the tag. The tenant id is the one place that can hold
     * it unforgeably.
     */
    @JvmStatic
    fun serviceQueueTenant(relayUrl: String?): String =
        if (relayUrl.isNullOrEmpty()) TENANT_SERVICE_QUEUE
        else "$TENANT_SERVICE_QUEUE_PREFIX${relayUrl.trimEnd('/')}"

    /** The relay a per-relay queue tenant belongs to, or null for the unscoped one. */
    @JvmStatic
    fun queueTenantRelay(tenant: String): String? =
        if (tenant.startsWith(TENANT_SERVICE_QUEUE_PREFIX))
            tenant.substring(TENANT_SERVICE_QUEUE_PREFIX.length)
        else null

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
