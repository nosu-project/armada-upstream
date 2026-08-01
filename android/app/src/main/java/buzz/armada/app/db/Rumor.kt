package buzz.armada.app.db

import org.json.JSONArray
import org.json.JSONObject

/**
 * A stored event: everything ArmadaDB holds is *already authenticated* by the
 * time it lands (a signature check, or gift-wrap decryption which authenticates
 * by construction), so the store deals in signature-less rumors and never
 * carries a `sig` it would have to lie about.
 *
 * The original JSON is kept verbatim (minus `sig`) rather than re-serialized
 * from the parsed fields, so a caller's own additions survive a round trip
 * through the store instead of being silently dropped by this model's idea of
 * what a rumor has.
 */
class Rumor private constructor(
    val id: String,
    val pubkey: String,
    val createdAt: Long,
    val kind: Int,
    /**
     * Tag rows. An entry that wasn't a JSON string is null: NIP-01 filters and
     * the tag index both compare against strings, so a null can never match,
     * which is what the WebView's `typeof value !== "string"` guards achieve.
     */
    val tags: List<List<String?>>,
    val content: String,
    private val body: JSONObject,
) {

    /** The stored form: the rumor's JSON, without a signature. */
    fun toJson(): String = body.toString()

    fun toJsonObject(): JSONObject = body

    /** The first value of the first tag named [name], or null. */
    fun tagValue(name: String): String? =
        tags.firstOrNull { it.size >= 2 && it[0] == name }?.get(1)

    override fun toString(): String = "Rumor(${id.take(8)}, kind=$kind)"

    companion object {
        /** Parse a rumor, or null if it isn't structurally one. */
        fun parse(json: String): Rumor? =
            runCatching { parse(JSONObject(json)) }.getOrNull()

        /**
         * Parse a rumor from an already-decoded object. A `sig` is stripped
         * rather than rejected: a caller can hand over a full signed event
         * structurally, and persisting the signature would make this store
         * disagree with every other adapter about what it holds.
         */
        fun parse(source: JSONObject): Rumor? {
            val id = source.optString("id")
            val pubkey = source.optString("pubkey")
            val kind = if (source.has("kind")) source.optInt("kind", -1) else -1
            if (id.isEmpty() || pubkey.isEmpty() || kind < 0) return null

            val body = copyWithoutSignature(source)
            val tagRows = ArrayList<List<String?>>()
            val tags = body.optJSONArray("tags")
            if (tags != null) {
                for (i in 0 until tags.length()) {
                    val tag = tags.optJSONArray(i) ?: continue
                    val row = ArrayList<String?>(tag.length())
                    for (j in 0 until tag.length()) {
                        val value = tag.opt(j)
                        row.add(if (value is String) value else null)
                    }
                    tagRows.add(row)
                }
            }

            return Rumor(
                id = id,
                pubkey = pubkey,
                createdAt = source.optLong("created_at", 0L),
                kind = kind,
                tags = tagRows,
                content = source.optString("content", ""),
                body = body,
            )
        }

        /**
         * Build a rumor from its parts, for the notification service's own
         * writes (an opened Concord rumor, a parked wrap). Tag rows are copied
         * verbatim, so provenance the caller folds in rides along.
         */
        fun of(
            id: String,
            pubkey: String,
            createdAt: Long,
            kind: Int,
            tags: List<List<String>>,
            content: String,
        ): Rumor? {
            val body = JSONObject()
            body.put("id", id)
            body.put("pubkey", pubkey)
            body.put("created_at", createdAt)
            body.put("kind", kind)
            body.put("content", content)
            val array = JSONArray()
            for (tag in tags) {
                val row = JSONArray()
                for (value in tag) row.put(value)
                array.put(row)
            }
            body.put("tags", array)
            return parse(body)
        }

        private fun copyWithoutSignature(source: JSONObject): JSONObject {
            if (!source.has("sig")) return source
            val copy = JSONObject()
            val keys = source.keys()
            while (keys.hasNext()) {
                val key = keys.next()
                if (key == "sig") continue
                copy.put(key, source.get(key))
            }
            return copy
        }
    }
}

/** Kind ranges, per NIP-01. */
internal object Kinds {
    fun ephemeral(kind: Int): Boolean = kind in 20000..29999
    fun replaceable(kind: Int): Boolean = kind == 0 || kind == 3 || kind in 10000..19999
    fun addressable(kind: Int): Boolean = kind in 30000..39999
}
