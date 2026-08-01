package buzz.armada.app.db

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONArray
import org.json.JSONObject

/**
 * The WebView's door onto the native [SqliteArmadaDb] — the Android transport
 * behind `src/lib/db/NativeArmadaDB.ts`.
 *
 * The database logic is NOT here. This bridge carries filters in and rumors out;
 * every filter is planned, every tag tokenized and every NIP-09 deletion applied
 * by the same Kotlin store the notification service writes through. That is the
 * point of the port: one engine, one file, one set of semantics, so an event the
 * service received at 3am is simply *in the store* when the app opens, rather
 * than being replayed into a second copy of the query engine.
 *
 * Everything crosses as JSON TEXT rather than as `JSObject` trees. Capacitor's
 * conversion would have to guess at number types (a `created_at` is a Long, a
 * `kind` an Int, and JavaScript has one number), and a page of rumors is far
 * cheaper to hand over as one string the WebView parses itself than as a few
 * thousand marshalled objects.
 *
 * Plugin calls run on Capacitor's background task thread, so the store's blocking
 * lock is held off the UI thread.
 */
@CapacitorPlugin(name = "ArmadaDB")
class ArmadaDbPlugin : Plugin() {

    private val db: SqliteArmadaDb
        get() = ArmadaDb.get(context)

    /** Rumors matching any of the filters, newest-first, as a JSON array. */
    @PluginMethod
    fun query(call: PluginCall) {
        val tenant = call.getString("tenant") ?: return call.reject("tenant is required")
        val filters = parseFilters(call) ?: return

        try {
            val rumors = db.query(tenant, filters)
            val array = JSONArray()
            for (rumor in rumors) array.put(rumor.toJsonObject())
            call.resolve(JSObject().put("rumors", array.toString()))
        } catch (error: Exception) {
            call.reject(error.message, error)
        }
    }

    /**
     * Store a batch of rumors in one transaction. `rumors` is a JSON array; the
     * WebView coalesces a burst into a single call, so the batch here IS the
     * burst and commits as one.
     */
    @PluginMethod
    fun event(call: PluginCall) {
        val tenant = call.getString("tenant") ?: return call.reject("tenant is required")
        val raw = call.getString("rumors") ?: return call.reject("rumors is required")

        try {
            val array = JSONArray(raw)
            val writes = ArrayList<SqliteArmadaDb.Write>(array.length())
            for (i in 0 until array.length()) {
                val body = array.optJSONObject(i) ?: continue
                val rumor = Rumor.parse(body) ?: continue
                writes.add(SqliteArmadaDb.Write(tenant, rumor))
            }
            db.write(writes)
            call.resolve()
        } catch (error: Exception) {
            call.reject(error.message, error)
        }
    }

    @PluginMethod
    fun count(call: PluginCall) {
        val tenant = call.getString("tenant") ?: return call.reject("tenant is required")
        val filters = parseFilters(call) ?: return

        try {
            val count = db.count(tenant, filters)
            call.resolve(
                JSObject()
                    .put("count", count.count)
                    .put("approximate", count.approximate),
            )
        } catch (error: Exception) {
            call.reject(error.message, error)
        }
    }

    @PluginMethod
    fun remove(call: PluginCall) {
        val tenant = call.getString("tenant") ?: return call.reject("tenant is required")
        val filters = parseFilters(call) ?: return

        try {
            db.remove(tenant, filters)
            call.resolve()
        } catch (error: Exception) {
            call.reject(error.message, error)
        }
    }

    /** Every tenant that has ever been written to (the logout purge reads this). */
    @PluginMethod
    fun tenants(call: PluginCall) {
        try {
            call.resolve(JSObject().put("tenants", JSONArray(db.tenantIds()).toString()))
        } catch (error: Exception) {
            call.reject(error.message, error)
        }
    }

    // ── KV ────────────────────────────────────────────────────────────────────
    //
    // Values cross as the JSON text the WebView serialized. Nothing here parses
    // them, so the store never has to agree with JavaScript about how a value
    // round-trips — `undefined`, a `Map`, a `bigint` are the caller's problem in
    // exactly the way the ArmadaKV contract already says they are.

    @PluginMethod
    fun kvGet(call: PluginCall) {
        val key = call.getString("key") ?: return call.reject("key is required")

        try {
            val value = db.kvGet(key)
            val result = JSObject()
            if (value != null) result.put("value", value)
            call.resolve(result)
        } catch (error: Exception) {
            call.reject(error.message, error)
        }
    }

    @PluginMethod
    fun kvSet(call: PluginCall) {
        val key = call.getString("key") ?: return call.reject("key is required")
        val value = call.getString("value") ?: return call.reject("value is required")

        try {
            db.kvSet(key, value)
            call.resolve()
        } catch (error: Exception) {
            call.reject(error.message, error)
        }
    }

    @PluginMethod
    fun kvDelete(call: PluginCall) {
        val key = call.getString("key") ?: return call.reject("key is required")

        try {
            db.kvDelete(key)
            call.resolve()
        } catch (error: Exception) {
            call.reject(error.message, error)
        }
    }

    @PluginMethod
    fun kvKeys(call: PluginCall) {
        try {
            call.resolve(JSObject().put("keys", JSONArray(db.kvKeys(call.getString("prefix"))).toString()))
        } catch (error: Exception) {
            call.reject(error.message, error)
        }
    }

    /** Empty every table (logout purge). The file and its schema survive. */
    @PluginMethod
    fun wipe(call: PluginCall) {
        try {
            db.wipe()
            call.resolve()
        } catch (error: Exception) {
            call.reject(error.message, error)
        }
    }

    /**
     * The call's `filters`, or null once the call has been rejected — a filter
     * list that didn't parse is a programming error on the JS side, and
     * answering it with "no constraints" would hand back the whole tenant.
     */
    private fun parseFilters(call: PluginCall): List<JSONObject>? {
        val raw = call.getString("filters")
        if (raw == null) {
            call.reject("filters is required")
            return null
        }

        return try {
            val array = JSONArray(raw)
            (0 until array.length()).mapNotNull { array.optJSONObject(it) }
        } catch (error: Exception) {
            call.reject("filters is not valid JSON", error)
            null
        }
    }
}
