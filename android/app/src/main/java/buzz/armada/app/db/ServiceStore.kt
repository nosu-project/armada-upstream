package buzz.armada.app.db

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

/**
 * What the background relay service writes, and where.
 *
 * The service used to keep its own database (`armada-events.db`) with its own
 * flat schema, and the only way anything reached the app was a cursor drain the
 * WebView replayed into a second store. Now there is one store: the service
 * writes an event into the same tenant the WebView would have written it to, so
 * a message received while the app was dead is simply THERE on open — no replay,
 * no second copy, no format to keep in step.
 *
 * The drain survives, but only as ROUTING. Storing a message and acting on it
 * are different jobs: wire ingest is what parks undecryptable wraps, rings the
 * scopes that repaint a timeline, and feeds notification candidates. So every
 * event also lands in [ArmadaDb.TENANT_SERVICE_QUEUE], which the WebView reads
 * and empties on open/resume (peek+ack: a page is only removed once ingest has
 * committed, so a crash mid-drain replays rather than loses).
 *
 * Failures are logged and swallowed throughout. A notification that arrives
 * without its event having been persisted is a degraded notification; a service
 * that dies on a write error posts nothing at all.
 */
object ServiceStore {

    private const val TAG = "ArmadaDb"

    /** Provenance tags the Concord V2 rumor store synthesizes for itself. */
    /** CORD-02 §5's encrypted seal — the only form a chat wrap may carry. */
    private const val SEAL_ENCRYPTED = 20013

    /** How stale a queued event may get before it is dropped unrouted. */
    private const val QUEUE_MAX_AGE_SECS = 14L * 24 * 3600

    /** Writes between prune passes — the sweep is a scan, not a per-write cost. */
    private const val PRUNE_INTERVAL = 500

    private var writesSincePrune = 0

    /**
     * Store a raw relay event in the general cache and queue it for wire ingest,
     * returning whether the cache ALREADY held it.
     *
     * That return is the durable dedupe floor for NIP-17 gift wraps, whose outer
     * timestamps are backdated by up to two days and so can't be gated on time:
     * a wrap either side ever stored — a previous service incarnation, the
     * WebView's inbox sync, or our own just-published self-copy — must not
     * re-notify.
     */
    @JvmStatic
    fun ingest(context: Context, event: JSONObject): Boolean {
        val rumor = Rumor.parse(event) ?: return false
        return try {
            val db = ArmadaDb.get(context)
            val stored = db.count(ArmadaDb.TENANT_MAIN, listOf(idFilter(rumor.id))).count > 0
            db.write(
                listOf(
                    SqliteArmadaDb.Write(ArmadaDb.TENANT_MAIN, rumor),
                    SqliteArmadaDb.Write(ArmadaDb.TENANT_SERVICE_QUEUE, rumor),
                ),
            )
            pruneQueue(db)
            stored
        } catch (error: Throwable) {
            Log.w(TAG, "ingest write failed", error)
            false
        }
    }

    /**
     * Drop queue entries older than [QUEUE_MAX_AGE_SECS].
     *
     * The queue is emptied on every app open or resume, so it only grows on an
     * install whose service runs for weeks without the app being opened — and
     * what accumulates there is pure routing, duplicating rows the tenants
     * already hold. Anything this old has nothing left to route: wire ingest
     * would park wraps whose keys have long since arrived by other means and
     * ring scopes for timelines nobody is looking at.
     *
     * Age rather than count, because the queue is read newest-first and there is
     * no cheap "oldest N" — and because the NIP-59 backdate window is two days,
     * so a cutoff has to be well clear of it to be safe.
     */
    private fun pruneQueue(db: SqliteArmadaDb) {
        if (++writesSincePrune < PRUNE_INTERVAL) return
        writesSincePrune = 0

        val cutoff = System.currentTimeMillis() / 1000 - QUEUE_MAX_AGE_SECS
        db.remove(ArmadaDb.TENANT_SERVICE_QUEUE, listOf(JSONObject().put("until", cutoff)))
    }

    /**
     * Store an event in the general cache WITHOUT queueing it for ingest —
     * for what the service fetched for its own use (a kind-0 profile, a
     * kind-39000 group name) or acted on itself (NIP-34 git activity). The
     * WebView reads all of it out of the cache like any other cached event; it
     * just has nothing to route.
     */
    @JvmStatic
    fun cache(context: Context, event: JSONObject) {
        val rumor = Rumor.parse(event) ?: return
        try {
            ArmadaDb.get(context).event(ArmadaDb.TENANT_MAIN, rumor)
        } catch (error: Throwable) {
            Log.w(TAG, "cache write failed", error)
        }
    }

    /** The stored kind-0 for a pubkey, or null — so a profile already fetched isn't fetched again. */
    @JvmStatic
    fun profileRaw(context: Context, pubkey: String): String? = try {
        val filter = JSONObject()
            .put("kinds", JSONArray().put(0))
            .put("authors", JSONArray().put(pubkey))
            .put("limit", 1)
        ArmadaDb.get(context).query(ArmadaDb.TENANT_MAIN, listOf(filter)).firstOrNull()?.toJson()
    } catch (error: Throwable) {
        Log.w(TAG, "profile read failed", error)
        null
    }

    /**
     * Park a Concord V2 wrap the service could not open, for the WebView, which
     * holds the stream keys. Stored without its signature: a wrap is signed by a
     * derived stream key that authenticates no individual, and everything that
     * does authenticate the message is the seal sealed inside it.
     */
    @JvmStatic
    fun parkConcord2Wrap(context: Context, wrap: JSONObject) {
        val rumor = Rumor.parse(wrap) ?: return
        try {
            ArmadaDb.get(context).event(ArmadaDb.TENANT_C2_PARK, rumor)
        } catch (error: Throwable) {
            Log.w(TAG, "park write failed", error)
        }
    }

    /**
     * Store a Concord V2 chat rumor the service decrypted, in its community's
     * opened-event tenant — the same row, byte for byte, that the WebView's
     * `openedToStored` writes.
     *
     * The rumor is stored EXACTLY as its author wrote it. Nothing about the
     * wrap is folded into its tags: a rumor's tags are the bytes its id commits
     * to, and the chat plane asks for none of it back — a channel read is a
     * `#channel` query, and that binding tag is the author's own. (The planes
     * that DO need the stream address get it from a separate bookkeeping row
     * the WebView writes; the service never opens a plane wrap.)
     *
     * Chat seals MUST be encrypted (CORD-02 §5). The WebView refuses a chat
     * wrap sealed in plaintext, and reads every stored chat row back as
     * encrypted-sealed on that strength — so a second writer filing one would
     * plant a row the reader then mislabels.
     *
     * `openConcord2` has already checked what makes this safe to file under a
     * channel: the seal's signature, that the rumor's author IS the seal's
     * signer, and that the channel/epoch binding matches the stream whose key
     * opened the wrap.
     */
    @JvmStatic
    fun storeConcord2Rumor(
        context: Context,
        communityIdHex: String,
        sealKind: Int,
        rumor: JSONObject,
    ) {
        if (communityIdHex.isEmpty()) return
        if (sealKind != SEAL_ENCRYPTED) {
            Log.w(TAG, "refusing a Concord chat rumor whose seal was not encrypted")
            return
        }
        val opened = Rumor.parse(rumor) ?: return

        try {
            ArmadaDb.get(context).event(ArmadaDb.communityTenant(communityIdHex), opened)
        } catch (error: Throwable) {
            Log.w(TAG, "concord rumor write failed", error)
        }
    }

    /**
     * File a decrypted NIP-17 rumor in the viewer's opened-DM tenant, under the
     * same rules the WebView's `writeDm17Rumors` applies — see [Dm17].
     *
     * The service decrypts DM wraps for its notifications regardless; storing
     * the result is what stops the app having to open the same wrap a second
     * time on launch, and is why a DM received overnight is in its thread
     * immediately. A kind-5 delete stored here triggers the store's self-only
     * NIP-09 pass, exactly as it does when the WebView writes one.
     *
     * The caller owns the crypto: that the seal's signature is good, that the
     * rumor's author IS the seal's signer, and that the rumor's id is the NIP-01
     * hash of its own contents rather than one the sender chose.
     */
    @JvmStatic
    fun storeDm17Rumor(context: Context, self: String, rumor: JSONObject) {
        val opened = Rumor.parse(rumor) ?: return
        if (!Dm17.storable(self, opened, System.currentTimeMillis() / 1000)) return

        try {
            ArmadaDb.get(context).event(Dm17.tenant(self), opened)
        } catch (error: Throwable) {
            Log.w(TAG, "dm rumor write failed", error)
        }
    }

    /**
     * Whether an event carries a NIP-40 deadline that has already passed.
     *
     * Used on the gift wrap and the seal before either is opened: a disappearing
     * message whose deadline is behind us is not delivered at all, matching the
     * WebView's `openDmWrap`, which refuses an expired envelope before it
     * decrypts anything.
     */
    @JvmStatic
    fun isExpired(event: JSONObject): Boolean {
        val parsed = Rumor.parse(event) ?: return false
        return Dm17.isExpired(parsed.tags, System.currentTimeMillis() / 1000)
    }

    // ── The service → WebView routing queue ──────────────────────────────────

    /** One page of queued events, and the ids that acknowledge it. */
    class Page(val events: List<String>, val ids: List<String>)

    /**
     * A page of queued events, oldest first. Nothing is removed: the WebView
     * acknowledges with [ackDrain] only once ingest has committed, so a page
     * interrupted by a crash is handed out again rather than lost.
     */
    @JvmStatic
    fun drain(context: Context, limit: Int): Page = try {
        val rumors = ArmadaDb.get(context)
            .query(ArmadaDb.TENANT_SERVICE_QUEUE, listOf(JSONObject().put("limit", limit)))
            .reversed()
        Page(rumors.map { it.toJson() }, rumors.map { it.id })
    } catch (error: Throwable) {
        Log.w(TAG, "drain failed", error)
        Page(emptyList(), emptyList())
    }

    /** Drop an acknowledged page from the queue. */
    @JvmStatic
    fun ackDrain(context: Context, ids: List<String>) {
        if (ids.isEmpty()) return
        try {
            val filter = JSONObject().put("ids", JSONArray(ids))
            ArmadaDb.get(context).remove(ArmadaDb.TENANT_SERVICE_QUEUE, listOf(filter))
        } catch (error: Throwable) {
            Log.w(TAG, "drain ack failed", error)
        }
    }

    private fun idFilter(id: String): JSONObject =
        JSONObject().put("ids", JSONArray().put(id))
}
