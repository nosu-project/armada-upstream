package buzz.armada.app.db

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The read path's serialization: a rumor rebuilt from stored columns writes its
 * own JSON rather than being re-derived through `org.json`.
 *
 * This is where the bridge's cost used to be — a query answered by building a
 * `JSONObject` per row and stringifying the lot, on top of the pass Capacitor
 * then makes to escape the payload into its response. The hand-written form is
 * only worth having if it is byte-for-byte a correct JSON encoder, so that is
 * what these assert: every escape JSON requires, the tags column spliced in
 * untouched, and the row-built form agreeing with the parsed form it replaced.
 */
class RumorJsonTest {

    private fun row(
        id: String = "a".repeat(64),
        pubkey: String = "b".repeat(64),
        createdAt: Long = 1_700_000_000,
        kind: Int = 1,
        tagsJson: String = """[["e","aa"],["p","bb"]]""",
        content: String = "hello",
    ): Rumor = Rumor.fromRow(id, kind, pubkey, createdAt, tagsJson, content)!!

    /** The six NIP-01 fields, as a comparable form. */
    private fun fields(json: String): List<Any?> {
        val o = JSONObject(json)
        return listOf(
            o.getString("id"),
            o.getString("pubkey"),
            o.getLong("created_at"),
            o.getInt("kind"),
            o.getJSONArray("tags").toString(),
            o.getString("content"),
        )
    }

    @Test
    fun `row-built rumor serializes to its six fields`() {
        val json = row().toJson()

        assertEquals(
            listOf("a".repeat(64), "b".repeat(64), 1_700_000_000L, 1, """[["e","aa"],["p","bb"]]""", "hello"),
            fields(json),
        )
    }

    @Test
    fun `row-built form agrees with the parsed form`() {
        val tags = """[["e","aa"],["p","bb"],["alt","a note"]]"""
        val built = row(tagsJson = tags, content = "hi there")
        val parsed = Rumor.parse(
            JSONObject()
                .put("id", "a".repeat(64))
                .put("pubkey", "b".repeat(64))
                .put("created_at", 1_700_000_000L)
                .put("kind", 1)
                .put("tags", JSONArray(tags))
                .put("content", "hi there"),
        )!!

        assertEquals(fields(parsed.toJson()), fields(built.toJson()))
        assertEquals(parsed.tags, built.tags)
    }

    @Test
    fun `content escapes survive a round trip`() {
        val content = "quote \" backslash \\ slash / newline \n tab \t return \r " +
            "backspace \b formfeed \u000C nul \u0000 unit \u001F emoji 🚢 accent é"

        val json = row(content = content).toJson()

        assertEquals(content, JSONObject(json).getString("content"))
    }

    @Test
    fun `control characters are escaped as valid JSON`() {
        val json = row(content = "\u0001\u001F").toJson()

        assertTrue(json, json.contains("\\u0001"))
        assertTrue(json, json.contains("\\u001f"))
        assertEquals("\u0001\u001F", JSONObject(json).getString("content"))
    }

    @Test
    fun `ids and keys are escaped too`() {
        // Not hex, deliberately: nothing about the column type stops a caller
        // from having written something that needs quoting.
        val rumor = row(id = "a\"b", pubkey = "c\\d")

        val json = rumor.toJson()

        assertEquals("a\"b", JSONObject(json).getString("id"))
        assertEquals("c\\d", JSONObject(json).getString("pubkey"))
    }

    @Test
    fun `tags column is spliced verbatim`() {
        // Whitespace inside the stored text survives, which is the proof it was
        // spliced rather than re-serialized.
        val rumor = row(tagsJson = """[["e", "aa"]]""")

        assertTrue(rumor.toJson(), rumor.toJson().contains("""[["e", "aa"]]"""))
    }

    @Test
    fun `tags parse lazily from the stored column`() {
        val rumor = row(tagsJson = """[["e","aa"],["p","bb",1,null]]""")

        assertEquals(
            listOf(listOf("e", "aa"), listOf("p", "bb", null, null)),
            rumor.tags,
        )
        assertEquals("aa", rumor.tagValue("e"))
        assertNull(rumor.tagValue("nope"))
    }

    @Test
    fun `empty tags serialize as an empty array`() {
        assertEquals("[]", JSONObject(row(tagsJson = "[]").toJson()).getJSONArray("tags").toString())
        assertEquals(emptyList<List<String?>>(), row(tagsJson = "[]").tags)
    }

    @Test
    fun `a row whose tags are not an array is refused`() {
        assertNull(Rumor.fromRow("a", 1, "b", 1, "{}", "c"))
        assertNull(Rumor.fromRow("a", 1, "b", 1, "", "c"))
        assertNull(Rumor.fromRow("a", 1, "b", 1, "null", "c"))
    }

    @Test
    fun `a parsed rumor keeps keys beyond the six and drops sig`() {
        val parsed = Rumor.parse(
            JSONObject()
                .put("id", "a")
                .put("pubkey", "b")
                .put("created_at", 5L)
                .put("kind", 1)
                .put("tags", JSONArray())
                .put("content", "c")
                .put("sig", "f".repeat(128))
                .put("extra", "kept"),
        )!!

        val json = JSONObject(parsed.toJson())

        assertFalse(json.has("sig"))
        assertEquals("kept", json.getString("extra"))
    }

    @Test
    fun `size hint covers an unescaped rumor`() {
        val rumor = row(content = "a".repeat(500))

        val hint = rumor.jsonSizeHint()
        val written = rumor.toJson().length
        assertTrue("hint $hint < written $written", hint >= written)
        // A hint far above the truth would waste the allocation it exists to save.
        assertTrue("hint $hint vs written $written", hint <= written + 64)
    }

    @Test
    fun `quote writes a bare string with no escapes needed`() {
        val out = StringBuilder()

        JsonText.quote(out, "plain ascii 123")

        assertEquals("\"plain ascii 123\"", out.toString())
    }
}
