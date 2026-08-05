package buzz.armada.app.db

import org.json.JSONArray
import org.json.JSONObject

/**
 * A stored event: everything ArmadaDB holds is *already authenticated* by the
 * time it lands (a signature check, or gift-wrap decryption which authenticates
 * by construction), so the store deals in signature-less rumors and never
 * carries a `sig` it would have to lie about.
 *
 * A rumor arrives one of two ways, and the difference is the whole performance
 * story of the read path:
 *
 *  - [parse] takes JSON a caller handed over. That object IS the rumor's form —
 *    it may carry keys beyond the six NIP-01 fields, so it is kept and
 *    re-emitted verbatim.
 *  - [fromRow] rebuilds one from the six columns the store persists. Here the
 *    tags are ALREADY JSON array text, straight out of SQLite, and the other
 *    five fields are scalars — so the rumor's JSON can be *written* rather than
 *    re-derived, splicing the tags column in untouched.
 *
 * Which is why the parsed forms — the tag rows, the `JSONObject` body — are
 * lazy. A query answers with rumors that are almost always only serialized
 * back out again ([appendJsonTo]); parsing every tag array into
 * `List<List<String?>>` and building a `JSONObject` per row, only to stringify
 * the lot through `org.json`, was four passes over data that needed none. Rows
 * that ARE inspected — the post-SQL filter check, the relay-scope rule, NIP-40
 * expiry — pay for the parse on first touch, once.
 */
class Rumor private constructor(
    val id: String,
    val pubkey: String,
    val createdAt: Long,
    val kind: Int,
    val content: String,
    /**
     * The JSON this rumor was parsed from (minus any `sig`), or null when it
     * was rebuilt from stored columns and its JSON is therefore derivable.
     */
    private val source: JSONObject?,
    /** The `tags` column: tag rows as JSON array text. Null when only [source] is known. */
    private val storedTags: String?,
) {

    /**
     * Tag rows. An entry that wasn't a JSON string is null: NIP-01 filters and
     * the tag index both compare against strings, so a null can never match,
     * which is what the WebView's `typeof value !== "string"` guards achieve.
     */
    val tags: List<List<String?>> by lazy { tagRows(tagsArray()) }

    /** The stored form: the rumor's JSON, without a signature. */
    fun toJson(): String {
        val source = this.source
        if (source != null) return source.toString()
        val out = StringBuilder(jsonSizeHint())
        appendJsonTo(out)
        return out.toString()
    }

    fun toJsonObject(): JSONObject = source ?: rebuiltBody

    /**
     * Append this rumor's JSON to [out].
     *
     * The point of the class: for a row-built rumor nothing is parsed and
     * nothing is re-derived — five scalars are written and the `tags` column is
     * spliced in as the JSON array text it already is.
     */
    fun appendJsonTo(out: StringBuilder) {
        val source = this.source
        if (source != null) {
            out.append(source.toString())
            return
        }
        out.append("{\"id\":")
        JsonText.quote(out, id)
        out.append(",\"pubkey\":")
        JsonText.quote(out, pubkey)
        out.append(",\"created_at\":").append(createdAt)
        out.append(",\"kind\":").append(kind)
        out.append(",\"tags\":").append(storedTags ?: "[]")
        out.append(",\"content\":")
        JsonText.quote(out, content)
        out.append('}')
    }

    /**
     * How many characters [appendJsonTo] will write, to presize a builder.
     *
     * Exact for a rumor whose strings need no escaping, which is the ordinary
     * case (hex ids, plain text); content full of quotes or control characters
     * writes more and costs the builder a resize, which is the cheap direction
     * to be wrong in.
     */
    internal fun jsonSizeHint(): Int =
        JSON_OVERHEAD + id.length + pubkey.length + content.length + (storedTags?.length ?: 2)

    /** The tag rows as JSON array text — the stored column form. */
    fun tagsJson(): String = storedTags ?: source?.optJSONArray("tags")?.toString() ?: "[]"

    /** The first value of the first tag named [name], or null. */
    fun tagValue(name: String): String? =
        tags.firstOrNull { it.size >= 2 && it[0] == name }?.get(1)

    override fun toString(): String = "Rumor(${id.take(8)}, kind=$kind)"

    /** The six-field body, rebuilt from the columns. Only a [toJsonObject] caller needs it. */
    private val rebuiltBody: JSONObject by lazy {
        JSONObject().apply {
            put("id", id)
            put("pubkey", pubkey)
            put("created_at", createdAt)
            put("kind", kind)
            put("tags", tagsArray() ?: JSONArray())
            put("content", content)
        }
    }

    private fun tagsArray(): JSONArray? =
        source?.optJSONArray("tags") ?: storedTags?.let { runCatching { JSONArray(it) }.getOrNull() }

    companion object {
        /**
         * The six-field form minus the field values: 64 characters of keys,
         * quotes, commas and braces, plus room for `created_at` (a Long, up to
         * 20 characters) and `kind` (an Int, up to 11).
         */
        private const val JSON_OVERHEAD = 64 + 20 + 11

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

            return Rumor(
                id = id,
                pubkey = pubkey,
                createdAt = source.optLong("created_at", 0L),
                kind = kind,
                content = source.optString("content", ""),
                source = copyWithoutSignature(source),
                storedTags = null,
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

        /**
         * Reassemble a rumor from its stored columns. The store persists only
         * the six NIP-01 fields, so the body is derivable from them and the
         * tags text is kept as the column form it already is.
         *
         * [tagsJson] is checked for its brackets rather than parsed: every row
         * was written by `insertRumor` from [tagsJson] of a parsed rumor, so the
         * text is a JSON array by construction, and parsing several thousand of
         * them to re-confirm that is the cost this class exists to avoid. A row
         * corrupt enough to fail the full parse still fails — at the point
         * something actually reads [tags].
         */
        fun fromRow(
            id: String,
            kind: Int,
            pubkey: String,
            createdAt: Long,
            tagsJson: String,
            content: String,
        ): Rumor? {
            if (id.isEmpty() || pubkey.isEmpty() || kind < 0) return null
            val tags = tagsJson.trim()
            if (!tags.startsWith("[") || !tags.endsWith("]")) return null

            return Rumor(
                id = id,
                pubkey = pubkey,
                createdAt = createdAt,
                kind = kind,
                content = content,
                source = null,
                storedTags = tags,
            )
        }

        private fun tagRows(tags: JSONArray?): List<List<String?>> {
            if (tags == null) return emptyList()
            val rows = ArrayList<List<String?>>(tags.length())
            for (i in 0 until tags.length()) {
                val tag = tags.optJSONArray(i) ?: continue
                val row = ArrayList<String?>(tag.length())
                for (j in 0 until tag.length()) {
                    val value = tag.opt(j)
                    row.add(if (value is String) value else null)
                }
                rows.add(row)
            }
            return rows
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

/**
 * Writing JSON text straight into a builder.
 *
 * `org.json`'s stringifier is the only tool the bridge had, and it is the wrong
 * shape for a page of rumors: it appends one character at a time through
 * `JSONStringer`, so handing it a result set costs a pass over every byte of
 * every field — on top of the pass Capacitor then makes to escape the finished
 * string into its response envelope. Here a string is scanned for the
 * characters JSON actually requires escaping and copied in runs, which for
 * rumor content (hex ids, ordinary text) is one bulk copy.
 */
internal object JsonText {

    private val HEX = "0123456789abcdef".toCharArray()

    /** Append [value] to [out] as a quoted, escaped JSON string. */
    fun quote(out: StringBuilder, value: String) {
        out.append('"')
        val length = value.length
        var start = 0
        for (i in 0 until length) {
            val c = value[i]
            val escape = when {
                c == '"' -> "\\\""
                c == '\\' -> "\\\\"
                c == '\n' -> "\\n"
                c == '\r' -> "\\r"
                c == '\t' -> "\\t"
                c == '\b' -> "\\b"
                c == '\u000C' -> "\\u000c"
                c < ' ' -> null
                else -> continue
            }
            if (i > start) out.append(value, start, i)
            if (escape != null) {
                out.append(escape)
            } else {
                out.append("\\u00")
                out.append(HEX[(c.code shr 4) and 0xF])
                out.append(HEX[c.code and 0xF])
            }
            start = i + 1
        }
        if (start < length) out.append(value, start, length)
        out.append('"')
    }
}

/** Kind ranges, per NIP-01. */
internal object Kinds {
    fun ephemeral(kind: Int): Boolean = kind in 20000..29999
    fun replaceable(kind: Int): Boolean = kind == 0 || kind == 3 || kind in 10000..19999
    fun addressable(kind: Int): Boolean = kind in 30000..39999
}
