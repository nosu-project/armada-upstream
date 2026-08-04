package buzz.armada.app.db

import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The conformance suite for the native ArmadaDB, ported from
 * `src/lib/db/ArmadaDB.test.ts` (the adapter-parity suite) and
 * `src/lib/db/SqliteArmadaDB.test.ts` (the SQLite internals the parity suite
 * can't see: query plans, index upkeep, tokenizer escaping, injection).
 *
 * This runs the REAL engine, not a stand-in: `androidx.sqlite:sqlite-bundled`
 * publishes the same SQLite 3.50.1 for the JVM as it does per Android ABI, so
 * an ordinary unit test exercises the FTS5 features (`contentless_delete`,
 * `automerge`, the `ascii tokenchars` tokenizer) and the JSON1 trigger the
 * schema depends on — which is what makes this suite evidence about the APK
 * rather than about a mock.
 */
class ArmadaDbTest {

    private var driver: RecordingDriver? = null
    private var store: SqliteArmadaDb? = null

    private fun open(search: Boolean = true): SqliteArmadaDb {
        val recording = RecordingDriver(BundledSqlDriver(":memory:"))
        driver = recording
        return SqliteArmadaDb(recording, search = search).also { store = it }
    }

    @After
    fun tearDown() {
        runCatching { store?.close() }
        store = null
        driver = null
    }

    // ── Tenant stores ─────────────────────────────────────────────────────────

    @Test
    fun `stores and queries a rumor`() {
        val db = open()
        val r = rumor(id = "a")
        db.event("c2:abc", r)

        val got = db.query("c2:abc", filters("{\"kinds\":[1]}"))
        assertEquals(listOf("a"), got.map { it.id })
        assertEquals(r.content, got[0].content)
    }

    @Test
    fun `strips a signature rather than storing it`() {
        val db = open()
        val signed = JSONObject(rumor(id = "a").toJson()).put("sig", "f".repeat(128))
        db.event("t", Rumor.parse(signed)!!)

        val got = db.query("t", filters("{}"))
        assertFalse(got[0].toJsonObject().has("sig"))
    }

    @Test
    fun `queries a multi-letter tag`() {
        val db = open()
        val inChannel = rumor(id = "a", tags = listOf(listOf("channel", "chan-1")))
        db.event("c2:abc", inChannel)
        db.event("c2:abc", rumor(id = "b", tags = listOf(listOf("channel", "chan-2"))))

        val got = db.query("c2:abc", filters("{\"#channel\":[\"chan-1\"]}"))
        assertEquals(listOf("a"), got.map { it.id })
    }

    @Test
    fun `isolates rumors between tenants`() {
        val db = open()
        db.event("c2:a", rumor(id = "a"))
        db.event("c2:b", rumor(id = "b"))

        assertEquals(listOf("a"), db.query("c2:a", filters("{}")).map { it.id })
        assertEquals(listOf("b"), db.query("c2:b", filters("{}")).map { it.id })
        assertEquals(emptyList<String>(), db.query("c2:c", filters("{}")).map { it.id })
    }

    @Test
    fun `isolates the tag index between tenants`() {
        val db = open()
        db.event("c2:a", rumor(id = "a", tags = listOf(listOf("channel", "chan-1"))))
        db.event("c2:b", rumor(id = "b", tags = listOf(listOf("channel", "chan-2"))))

        assertEquals(emptyList<String>(), db.query("c2:b", filters("{\"#channel\":[\"chan-1\"]}")).map { it.id })
        assertEquals(listOf("a"), db.query("c2:a", filters("{\"#channel\":[\"chan-1\"]}")).map { it.id })
    }

    @Test
    fun `returns rumors newest first, ties broken by smaller id`() {
        val db = open()
        db.event("t", rumor(id = "b", createdAt = 100))
        db.event("t", rumor(id = "a", createdAt = 100))
        db.event("t", rumor(id = "c", createdAt = 200))

        assertEquals(listOf("c", "a", "b"), db.query("t", filters("{}")).map { it.id })
    }

    @Test
    fun `applies each filter's limit`() {
        val db = open()
        for (i in 1..5) db.event("t", rumor(id = "r$i", createdAt = 100L + i))

        assertEquals(listOf("r5", "r4"), db.query("t", filters("{\"limit\":2}")).map { it.id })
    }

    @Test
    fun `ORs several filters and de-duplicates by id`() {
        val db = open()
        db.event("t", rumor(id = "a", kind = 1, createdAt = 100))
        db.event("t", rumor(id = "b", kind = 7, createdAt = 200))

        val got = db.query("t", filters("{\"kinds\":[1]}", "{\"kinds\":[1,7]}"))
        assertEquals(listOf("b", "a"), got.map { it.id })
    }

    @Test
    fun `an empty array constraint matches nothing`() {
        val db = open()
        db.event("t", rumor(id = "a"))

        assertEquals(emptyList<String>(), db.query("t", filters("{\"ids\":[]}")).map { it.id })
        assertEquals(emptyList<String>(), db.query("t", filters("{\"kinds\":[]}")).map { it.id })
        assertEquals(emptyList<String>(), db.query("t", filters("{\"#e\":[]}")).map { it.id })
    }

    @Test
    fun `a constraint whose values all fail to decode matches nothing`() {
        // Same thing as `[]` once decoded, and the same answer: a narrowing
        // query that isn't understood must not come back with the tenant. It is
        // also what keeps the planner from emitting `IN ()`, which is not SQL.
        val db = open()
        db.event("t", rumor(id = "a", kind = 1))

        assertEquals(emptyList<String>(), db.query("t", filters("{\"kinds\":[\"1\"]}")).map { it.id })
        assertEquals(emptyList<String>(), db.query("t", filters("{\"authors\":[7]}")).map { it.id })
        assertEquals(emptyList<String>(), db.query("t", filters("{\"ids\":[null]}")).map { it.id })
        assertEquals(emptyList<String>(), db.query("t", filters("{\"#e\":\"a\"}")).map { it.id })

        // And it is the CONSTRAINT that fails, not the whole query: a filter
        // with no such key is unaffected.
        assertEquals(listOf("a"), db.query("t", filters("{\"kinds\":[1]}")).map { it.id })
    }

    @Test
    fun `honours ids, authors, kinds and the time window`() {
        val db = open()
        db.event("t", rumor(id = "a", pubkey = "alice", kind = 1, createdAt = 100))
        db.event("t", rumor(id = "b", pubkey = "bob", kind = 1, createdAt = 200))
        db.event("t", rumor(id = "c", pubkey = "alice", kind = 7, createdAt = 300))

        assertEquals(listOf("b"), db.query("t", filters("{\"ids\":[\"b\"]}")).map { it.id })
        assertEquals(listOf("c", "a"), db.query("t", filters("{\"authors\":[\"alice\"]}")).map { it.id })
        assertEquals(listOf("b", "a"), db.query("t", filters("{\"kinds\":[1]}")).map { it.id })
        assertEquals(listOf("a"), db.query("t", filters("{\"authors\":[\"alice\"],\"kinds\":[1]}")).map { it.id })
        assertEquals(listOf("b", "a"), db.query("t", filters("{\"until\":200}")).map { it.id })
        assertEquals(listOf("c", "b"), db.query("t", filters("{\"since\":200}")).map { it.id })
    }

    @Test
    fun `never stores an ephemeral kind`() {
        val db = open()
        db.event("t", rumor(id = "a", kind = 20001))

        assertEquals(emptyList<String>(), db.query("t", filters("{}")).map { it.id })
    }

    @Test
    fun `stores a rumor whose tag value is too long to index`() {
        val db = open()
        val huge = "x".repeat(500)
        db.event("t", rumor(id = "a", tags = listOf(listOf("blob", huge))))

        assertEquals(listOf("a"), db.query("t", filters("{}")).map { it.id })
        // Indexed tags cap the value length, so the tag itself is not queryable.
        assertEquals(
            emptyList<String>(),
            db.query("t", listOf(JSONObject().put("#blob", JSONArray().put(huge)))).map { it.id },
        )
    }

    @Test
    fun `re-delivering a rumor is a no-op`() {
        val db = open()
        db.event("t", rumor(id = "a"))
        db.event("t", rumor(id = "a"))

        assertEquals(1, db.query("t", filters("{}")).size)
        assertEquals(1L, db.count("t", filters("{}")).count)
    }

    @Test
    fun `counts and removes`() {
        val db = open()
        db.event("t", rumor(id = "a", kind = 1))
        db.event("t", rumor(id = "b", kind = 7))

        assertEquals(2L, db.count("t", filters("{}")).count)
        assertEquals(1L, db.count("t", filters("{\"kinds\":[7]}")).count)
        assertFalse(db.count("t", filters("{}")).approximate)

        db.remove("t", filters("{\"kinds\":[7]}"))
        assertEquals(listOf("a"), db.query("t", filters("{}")).map { it.id })
    }

    @Test
    fun `writes a batch as one transaction`() {
        val db = open()
        db.write(
            listOf(
                SqliteArmadaDb.Write("a", rumor(id = "1")),
                SqliteArmadaDb.Write("b", rumor(id = "2")),
            ),
        )

        assertEquals(listOf("1"), db.query("a", filters("{}")).map { it.id })
        assertEquals(listOf("2"), db.query("b", filters("{}")).map { it.id })
    }

    // ── Replaceable rumors ────────────────────────────────────────────────────

    @Test
    fun `a newer replaceable rumor supersedes the older one`() {
        val db = open()
        db.event("t", rumor(id = "old", kind = 0, pubkey = "alice", createdAt = 100))
        db.event("t", rumor(id = "new", kind = 0, pubkey = "alice", createdAt = 200))

        assertEquals(listOf("new"), db.query("t", filters("{}")).map { it.id })
    }

    @Test
    fun `a stale replaceable write is skipped`() {
        val db = open()
        db.event("t", rumor(id = "new", kind = 0, pubkey = "alice", createdAt = 200))
        db.event("t", rumor(id = "old", kind = 0, pubkey = "alice", createdAt = 100))

        assertEquals(listOf("new"), db.query("t", filters("{}")).map { it.id })
    }

    @Test
    fun `equal created_at is broken by the smaller id, and the stored one wins`() {
        val db = open()
        db.event("t", rumor(id = "bbb", kind = 0, pubkey = "alice", createdAt = 100))
        db.event("t", rumor(id = "aaa", kind = 0, pubkey = "alice", createdAt = 100))
        assertEquals(listOf("aaa"), db.query("t", filters("{}")).map { it.id })

        db.event("t", rumor(id = "ccc", kind = 0, pubkey = "alice", createdAt = 100))
        assertEquals(listOf("aaa"), db.query("t", filters("{}")).map { it.id })
    }

    @Test
    fun `addressable rumors supersede per d tag`() {
        val db = open()
        db.event("t", rumor(id = "a1", kind = 30000, pubkey = "alice", createdAt = 100, tags = listOf(listOf("d", "one"))))
        db.event("t", rumor(id = "b1", kind = 30000, pubkey = "alice", createdAt = 100, tags = listOf(listOf("d", "two"))))
        db.event("t", rumor(id = "a2", kind = 30000, pubkey = "alice", createdAt = 200, tags = listOf(listOf("d", "one"))))

        assertEquals(setOf("a2", "b1"), db.query("t", filters("{}")).map { it.id }.toSet())
    }

    @Test
    fun `supersession is per tenant and per author`() {
        val db = open()
        db.event("a", rumor(id = "one", kind = 0, pubkey = "alice", createdAt = 100))
        db.event("b", rumor(id = "two", kind = 0, pubkey = "alice", createdAt = 200))
        db.event("a", rumor(id = "three", kind = 0, pubkey = "bob", createdAt = 200))

        assertEquals(setOf("one", "three"), db.query("a", filters("{}")).map { it.id }.toSet())
        assertEquals(listOf("two"), db.query("b", filters("{}")).map { it.id })
    }

    // ── NIP-09 deletion ───────────────────────────────────────────────────────

    @Test
    fun `a kind 5 deletes the author's own targeted rumor`() {
        val db = open()
        db.event("t", rumor(id = "target", pubkey = "alice", createdAt = 100))
        db.event("t", rumor(id = "del", kind = 5, pubkey = "alice", createdAt = 200, tags = listOf(listOf("e", "target"))))

        // The request itself is retained.
        assertEquals(listOf("del"), db.query("t", filters("{}")).map { it.id })
    }

    @Test
    fun `a kind 5 cannot delete another author's rumor`() {
        val db = open()
        db.event("t", rumor(id = "target", pubkey = "alice", createdAt = 100))
        db.event("t", rumor(id = "del", kind = 5, pubkey = "mallory", createdAt = 200, tags = listOf(listOf("e", "target"))))

        assertEquals(setOf("target", "del"), db.query("t", filters("{}")).map { it.id }.toSet())
    }

    @Test
    fun `a kind 5 deletes by coordinate but spares a newer replacement`() {
        val db = open()
        db.event(
            "t",
            rumor(id = "old", kind = 30000, pubkey = "alice", createdAt = 100, tags = listOf(listOf("d", "x"))),
        )
        db.event(
            "t",
            rumor(id = "del", kind = 5, pubkey = "alice", createdAt = 150, tags = listOf(listOf("a", "30000:alice:x"))),
        )
        assertEquals(listOf("del"), db.query("t", filters("{}")).map { it.id })

        db.event(
            "t",
            rumor(id = "fresh", kind = 30000, pubkey = "alice", createdAt = 200, tags = listOf(listOf("d", "x"))),
        )
        db.event(
            "t",
            rumor(id = "del2", kind = 5, pubkey = "alice", createdAt = 160, tags = listOf(listOf("a", "30000:alice:x"))),
        )
        assertTrue(db.query("t", filters("{}")).any { it.id == "fresh" })
    }

    @Test
    fun `a crafted a tag cannot delete another author's coordinate`() {
        val db = open()
        db.event(
            "t",
            rumor(id = "victim", kind = 30000, pubkey = "alice", createdAt = 100, tags = listOf(listOf("d", "x"))),
        )
        db.event(
            "t",
            rumor(id = "del", kind = 5, pubkey = "mallory", createdAt = 200, tags = listOf(listOf("a", "30000:alice:x"))),
        )

        assertTrue(db.query("t", filters("{}")).any { it.id == "victim" })
    }

    // ── NIP-50 search ─────────────────────────────────────────────────────────

    @Test
    fun `search matches whole words, case and accent insensitively`() {
        val db = open()
        db.event("t", rumor(id = "a", content = "The quick brown fox"))
        db.event("t", rumor(id = "b", content = "CAFÉ society"))

        assertEquals(listOf("a"), db.query("t", filters("{\"search\":\"BROWN\"}")).map { it.id })
        assertEquals(listOf("b"), db.query("t", filters("{\"search\":\"cafe\"}")).map { it.id })
        // Whole words, not substrings.
        assertEquals(emptyList<String>(), db.query("t", filters("{\"search\":\"brow\"}")).map { it.id })
    }

    @Test
    fun `search ANDs keywords and honours negation`() {
        val db = open()
        db.event("t", rumor(id = "a", content = "red boat"))
        db.event("t", rumor(id = "b", content = "red anchor"))

        assertEquals(listOf("a"), db.query("t", filters("{\"search\":\"red -anchor\"}")).map { it.id })
        assertEquals(emptyList<String>(), db.query("t", filters("{\"search\":\"red sail\"}")).map { it.id })
    }

    @Test
    fun `search intersects with a tag-driven scan and is tenant-scoped`() {
        val db = open()
        db.event("a", rumor(id = "hit", content = "red boat", tags = listOf(listOf("channel", "c1"))))
        db.event("a", rumor(id = "miss", content = "blue boat", tags = listOf(listOf("channel", "c1"))))
        db.event("b", rumor(id = "other", content = "red boat"))

        assertEquals(
            listOf("hit"),
            db.query("a", filters("{\"#channel\":[\"c1\"],\"search\":\"red\"}")).map { it.id },
        )
        assertEquals(listOf("other"), db.query("b", filters("{\"search\":\"red\"}")).map { it.id })
    }

    @Test
    fun `a search parsing to no keywords fails closed`() {
        val db = open()
        db.event("t", rumor(id = "a", content = "anything"))

        assertEquals(emptyList<String>(), db.query("t", filters("{\"search\":\"domain:example.com\"}")).map { it.id })
        // A blank search asked for nothing, so it constrains nothing.
        assertEquals(listOf("a"), db.query("t", filters("{\"search\":\"  \"}")).map { it.id })
    }

    @Test
    fun `search still works with the content index off`() {
        val db = open(search = false)
        db.event("t", rumor(id = "a", content = "The quick brown fox"))

        assertEquals(listOf("a"), db.query("t", filters("{\"search\":\"brown\"}")).map { it.id })
        // Without the index it is a substring match, matching IndexedDB.
        assertEquals(listOf("a"), db.query("t", filters("{\"search\":\"brow\"}")).map { it.id })
    }

    @Test
    fun `a removed rumor disappears from the search index`() {
        val db = open()
        db.event("t", rumor(id = "a", content = "findable"))
        db.remove("t", filters("{\"ids\":[\"a\"]}"))

        assertEquals(emptyList<String>(), db.query("t", filters("{\"search\":\"findable\"}")).map { it.id })
    }

    // ── Query plans ───────────────────────────────────────────────────────────

    @Test
    fun `the token index drives a tag filter and rumors is never scanned`() {
        val db = open()
        db.event("t", rumor(id = "a", tags = listOf(listOf("channel", "c1"))))

        val plans = driver!!.record { db.query("t", filters("{\"#channel\":[\"c1\"],\"kinds\":[1]}")) }

        assertTrue(plans.any { it.contains("rumor_tags_fts") })
        assertTrue(plans.none { it.contains("SCAN rumors") })
    }

    @Test
    fun `an author is folded into the same MATCH as a tag`() {
        val db = open()
        db.event("t", rumor(id = "a", pubkey = "alice", tags = listOf(listOf("channel", "c1"))))

        driver!!.record { db.query("t", filters("{\"#channel\":[\"c1\"],\"authors\":[\"alice\"]}")) }

        val match = driver!!.lastMatchExpression()
        assertTrue(match!!.contains(":_p:alice"))
        assertTrue(match.contains(":channel:c1"))
    }

    @Test
    fun `a filter naming only authors and kinds uses the composite index`() {
        val db = open()
        db.event("t", rumor(id = "a", pubkey = "alice"))

        val plans = driver!!.record { db.query("t", filters("{\"authors\":[\"alice\"],\"kinds\":[1]}")) }
        assertTrue(plans.any { it.contains("rumors_pubkey_kind") })
    }

    @Test
    fun `an unconstrained filter walks the tenant index`() {
        val db = open()
        db.event("t", rumor(id = "a"))

        val plans = driver!!.record { db.query("t", filters("{}")) }
        assertTrue(plans.any { it.contains("rumors_tenant") })
    }

    @Test
    fun `a tag filter on a tenant that was never written short-circuits`() {
        val db = open()
        db.event("other", rumor(id = "a", tags = listOf(listOf("channel", "c1"))))

        driver!!.record { db.query("empty", filters("{\"#channel\":[\"c1\"]}")) }

        // The tenant lookup is the only statement: with no interned ordinal
        // there are no tokens to match, so neither the index nor the table is
        // touched at all.
        assertTrue(driver!!.selects.none { it.first.contains("rumors") })
    }

    @Test
    fun `counting a complete plan never reads a rumor body`() {
        val db = open()
        db.event("t", rumor(id = "a", tags = listOf(listOf("channel", "c1"))))

        driver!!.record { assertEquals(1L, db.count("t", filters("{\"#channel\":[\"c1\"]}")).count) }
        assertTrue(driver!!.selects.none { it.first.contains("content") })
    }

    // ── Index upkeep ──────────────────────────────────────────────────────────

    @Test
    fun `no token row outlives supersession`() {
        val db = open()
        db.event("t", rumor(id = "old", kind = 0, pubkey = "alice", createdAt = 100, tags = listOf(listOf("channel", "c1"))))
        db.event("t", rumor(id = "new", kind = 0, pubkey = "alice", createdAt = 200, tags = listOf(listOf("channel", "c2"))))

        assertEquals(emptyList<String>(), db.query("t", filters("{\"#channel\":[\"c1\"]}")).map { it.id })
        assertEquals(listOf("new"), db.query("t", filters("{\"#channel\":[\"c2\"]}")).map { it.id })
    }

    @Test
    fun `no token or coordinate row outlives removal`() {
        val db = open()
        db.event("t", rumor(id = "a", kind = 30000, pubkey = "alice", tags = listOf(listOf("d", "x"), listOf("channel", "c1"))))
        db.remove("t", filters("{\"ids\":[\"a\"]}"))

        assertEquals(emptyList<String>(), db.query("t", filters("{\"#channel\":[\"c1\"]}")).map { it.id })
        assertEquals(0L, rowCount("rumor_coords"))
        assertEquals(0L, rowCount("rumors"))

        // The coordinate is free again.
        db.event("t", rumor(id = "b", kind = 30000, pubkey = "alice", createdAt = 50, tags = listOf(listOf("d", "x"))))
        assertEquals(listOf("b"), db.query("t", filters("{}")).map { it.id })
    }

    @Test
    fun `wipe empties every table`() {
        val db = open()
        db.event("t", rumor(id = "a", tags = listOf(listOf("channel", "c1"))))
        db.kvSet("k", "1")
        db.wipe()

        assertEquals(emptyList<String>(), db.query("t", filters("{}")).map { it.id })
        assertEquals(emptyList<KvEntry>(), db.kvList())
        assertEquals(emptyList<String>(), db.tenantIds())
        assertEquals(0L, rowCount("rumors"))
        assertEquals(0L, rowCount("rumor_coords"))

        // The tenant interning starts over without naming the wrong namespace.
        db.event("u", rumor(id = "b", tags = listOf(listOf("channel", "c1"))))
        assertEquals(emptyList<String>(), db.query("t", filters("{\"#channel\":[\"c1\"]}")).map { it.id })
        assertEquals(listOf("b"), db.query("u", filters("{\"#channel\":[\"c1\"]}")).map { it.id })
    }

    // ── Injection ─────────────────────────────────────────────────────────────

    @Test
    fun `a hostile tag value is escaped rather than tokenized`() {
        val db = open()
        val hostile = "c1\" OR \"x\" AND (b"
        db.event("t", rumor(id = "a", tags = listOf(listOf("channel", hostile))))
        db.event("t", rumor(id = "b", tags = listOf(listOf("channel", "c1"))))

        val got = db.query("t", listOf(JSONObject().put("#channel", JSONArray().put(hostile))))
        assertEquals(listOf("a"), got.map { it.id })
    }

    @Test
    fun `a tag cannot forge another rumor's author token`() {
        val db = open()
        db.event("t", rumor(id = "victim", pubkey = "alice", tags = listOf(listOf("channel", "c1"))))
        // A tag literally named `_p` would collide with the reserved author
        // prefix if names weren't escaped.
        db.event("t", rumor(id = "forged", pubkey = "mallory", tags = listOf(listOf("_p", "alice"), listOf("channel", "c1"))))

        val got = db.query("t", filters("{\"#channel\":[\"c1\"],\"authors\":[\"alice\"]}"))
        assertEquals(listOf("victim"), got.map { it.id })
    }

    @Test
    fun `a forged token prefix cannot reach another tenant`() {
        val db = open()
        db.event("main", rumor(id = "secret", tags = listOf(listOf("channel", "private"))))
        // `t0`/`t1` are what the tenant prefixes look like; a tag value spelling
        // one out must not become another tenant's posting list.
        db.event("evil", rumor(id = "probe", tags = listOf(listOf("t1", "channel:private"))))

        assertEquals(emptyList<String>(), db.query("evil", filters("{\"#channel\":[\"private\"]}")).map { it.id })
        assertEquals(listOf("secret"), db.query("main", filters("{\"#channel\":[\"private\"]}")).map { it.id })
    }

    @Test
    fun `control characters survive every user-controlled string`() {
        val db = open()
        val nasty = "a\u0000b\u001f\"'\\;--\n\t"
        db.event(nasty, rumor(id = nasty, pubkey = nasty, content = nasty, tags = listOf(listOf(nasty, nasty))))

        val got = db.query(nasty, listOf(JSONObject().put("#$nasty", JSONArray().put(nasty))))
        assertEquals(listOf(nasty), got.map { it.id })
        assertEquals(nasty, got[0].content)
    }

    @Test
    fun `a NUL in a search falls back to the in-memory match`() {
        val db = open()
        db.event("t", rumor(id = "a", content = "hello"))

        // FTS5's query parser is NUL-terminated, so such a keyword can't be put
        // to the index at all; it is matched in memory instead, where it matches
        // nothing rather than quietly searching for "hel".
        val filter = JSONObject().put("search", "hel\u0000lo")
        assertEquals(emptyList<String>(), db.query("t", listOf(filter)).map { it.id })
    }

    @Test
    fun `a hostile kv key round-trips`() {
        val db = open()
        val key = "k\u0000'\";--"
        db.kvSet(key, "{\"a\":1}")

        assertEquals("{\"a\":1}", db.kvGet(key))
        assertEquals(listOf(KvEntry(key, "{\"a\":1}")), db.kvList("k"))
    }

    // ── KV ────────────────────────────────────────────────────────────────────

    @Test
    fun `kv gets, sets, overwrites and deletes`() {
        val db = open()
        assertNull(db.kvGet("missing"))

        db.kvSet("a", "1")
        assertEquals("1", db.kvGet("a"))

        db.kvSet("a", "2")
        assertEquals("2", db.kvGet("a"))

        db.kvDelete("a")
        assertNull(db.kvGet("a"))
        // Deleting a key that was never set is a no-op, not an error.
        db.kvDelete("a")
    }

    @Test
    fun `kv entries are prefix-scanned and ordered`() {
        val db = open()
        for (key in listOf("b:1", "a:2", "a:1", "a:10")) db.kvSet(key, "null")

        assertEquals(listOf("a:1", "a:10", "a:2", "b:1"), db.kvList().map { it.key })
        assertEquals(listOf("a:1", "a:10", "a:2"), db.kvList("a:").map { it.key })
        assertEquals(emptyList<KvEntry>(), db.kvList("zzz"))
    }

    @Test
    fun `kv list carries the value with the key`() {
        val db = open()
        db.kvSet("a:1", "{\"since\":7}")
        db.kvSet("a:2", "null")

        // The JSON text, verbatim: nothing native parses or respells it.
        assertEquals(
            listOf(KvEntry("a:1", "{\"since\":7}"), KvEntry("a:2", "null")),
            db.kvList("a:"),
        )
    }

    @Test
    fun `a prefix is a boundary, not a substring`() {
        val db = open()
        db.kvSet("ab", "null")
        db.kvSet("b", "null")

        assertEquals(listOf("ab"), db.kvList("a").map { it.key })
    }

    @Test
    fun `kv list scans a half-open range`() {
        val db = open()
        for (key in listOf("a", "b", "c", "d")) db.kvSet(key, "null")

        // `start` inclusive, `end` exclusive.
        assertEquals(listOf("b", "c"), db.kvList(start = "b", end = "d").map { it.key })
        assertEquals(listOf("c", "d"), db.kvList(start = "c").map { it.key })
        assertEquals(listOf("a"), db.kvList(end = "b").map { it.key })
    }

    @Test
    fun `kv list resumes a prefix scan from a cursor`() {
        val db = open()
        for (n in 1..4) db.kvSet("log:$n", "null")

        assertEquals(listOf("log:3", "log:4"), db.kvList("log:", start = "log:3").map { it.key })
        assertEquals(listOf("log:1", "log:2"), db.kvList("log:", end = "log:3").map { it.key })
    }

    @Test
    fun `kvOps executes a mixed batch in arrival order`() {
        val db = open()

        // Read-your-writes inside one batch: each get sees the set before it.
        val results = db.kvOps(
            listOf(
                SqliteArmadaDb.KvOp.Set("a", "1"),
                SqliteArmadaDb.KvOp.Get("a"),
                SqliteArmadaDb.KvOp.Set("a", "2"),
                SqliteArmadaDb.KvOp.Get("a"),
                SqliteArmadaDb.KvOp.Delete("a"),
                SqliteArmadaDb.KvOp.Get("a"),
            ),
        )

        assertEquals(listOf(null, "1", null, "2", null, null), results)
        assertNull(db.kvGet("a"))
    }

    @Test
    fun `kvOps scan sees earlier writes in the same batch`() {
        val db = open()

        val results = db.kvOps(
            listOf(
                SqliteArmadaDb.KvOp.Set("p:1", "1"),
                SqliteArmadaDb.KvOp.Set("p:2", "2"),
                SqliteArmadaDb.KvOp.Scan(prefix = "p:"),
            ),
        )

        assertEquals(listOf(KvEntry("p:1", "1"), KvEntry("p:2", "2")), results[2])
    }

    @Test
    fun `kvOps answers a read-only batch without a transaction`() {
        val db = open()
        db.kvSet("k", "\"v\"")

        val results = db.kvOps(
            listOf(
                SqliteArmadaDb.KvOp.Get("k"),
                SqliteArmadaDb.KvOp.Get("missing"),
                SqliteArmadaDb.KvOp.Scan(prefix = "zzz"),
            ),
        )

        assertEquals("\"v\"", results[0])
        assertNull(results[1])
        assertEquals(emptyList<KvEntry>(), results[2])
    }

    @Test
    fun `kvOps scan honors range, limit and reverse like kvList`() {
        val db = open()
        for (n in 1..4) db.kvSet("log:$n", "null")

        val results = db.kvOps(
            listOf(
                SqliteArmadaDb.KvOp.Scan(prefix = "log:", start = "log:3"),
                SqliteArmadaDb.KvOp.Scan(prefix = "log:", limit = 2),
                SqliteArmadaDb.KvOp.Scan(prefix = "log:", reverse = true, limit = 1),
            ),
        )

        @Suppress("UNCHECKED_CAST")
        fun keys(i: Int) = (results[i] as List<KvEntry>).map { it.key }
        assertEquals(listOf("log:3", "log:4"), keys(0))
        assertEquals(listOf("log:1", "log:2"), keys(1))
        assertEquals(listOf("log:4"), keys(2))
    }

    @Test
    fun `a range bound stays inside its prefix`() {
        val db = open()
        db.kvSet("p:1", "null")
        db.kvSet("q:1", "null")

        // A bound outside the prefix narrows to nothing rather than escaping it.
        assertEquals(emptyList<KvEntry>(), db.kvList("p:", start = "q:"))
        assertEquals(emptyList<KvEntry>(), db.kvList("p:", end = "a"))
        assertEquals(listOf("p:1"), db.kvList("p:", start = "a").map { it.key })
    }

    @Test
    fun `kv list is empty when the bounds cross`() {
        val db = open()
        db.kvSet("b", "null")

        assertEquals(emptyList<KvEntry>(), db.kvList(start = "z", end = "a"))
        assertEquals(emptyList<KvEntry>(), db.kvList(start = "b", end = "b"))
    }

    @Test
    fun `kv list refuses a prefix given both bounds`() {
        val db = open()

        // The bounds already describe the range; a prefix on top of them is
        // either redundant or a contradiction.
        assertThrows(IllegalArgumentException::class.java) {
            db.kvList("p:", start = "p:1", end = "p:9")
        }
    }

    @Test
    fun `kv list limits and reverses`() {
        val db = open()
        for (n in 1..3) db.kvSet("p:$n", "null")

        assertEquals(listOf("p:1", "p:2"), db.kvList("p:", limit = 2).map { it.key })
        assertEquals(emptyList<KvEntry>(), db.kvList("p:", limit = 0))
        assertEquals(listOf("p:3", "p:2", "p:1"), db.kvList("p:", reverse = true).map { it.key })
        // A limit takes from the front of the order it was asked for, so
        // reversing makes it the LAST entries.
        assertEquals(listOf("p:3"), db.kvList("p:", limit = 1, reverse = true).map { it.key })
    }

    @Test
    fun `a prefix ending in the maximal code unit scans open-ended`() {
        val db = open()
        val prefix = "x\uffff"
        db.kvSet("${prefix}1", "null")
        db.kvSet("y", "null")

        // There is no exclusive upper bound for this prefix, so the range is
        // open-ended and everything above it is read and then filtered. What
        // comes back must still be only genuine matches — never the tail of the
        // store, and never a page filled out to `limit` from beyond the prefix.
        assertEquals(emptyList<KvEntry>(), db.kvList(prefix))
        assertEquals(emptyList<KvEntry>(), db.kvList(prefix, limit = 2))

        // ENGINE NOTE: the bundled SQLite's JNI boundary replaces U+FFFF (a
        // Unicode noncharacter) with U+FFFD, so a key containing one cannot
        // round-trip and can never match a prefix spelling the original. The
        // web build's adapters keep it verbatim. Nothing Armada stores is
        // affected — no tenant id, cursor key or cache key is built from
        // noncharacters — but a future key space must not assume otherwise.
        assertEquals(listOf("x\ufffd1", "y"), db.kvList().map { it.key })
    }

    // ── Schema migration ──────────────────────────────────────────────────────

    @Test
    fun `rebuilds a v0 file into the v1 layout, preserving everything`() {
        val raw = BundledSqlDriver(":memory:")

        // The v0 layout, as shipped before schema versioning.
        val v0Schema = listOf(
            "CREATE TABLE rumors ( seq INTEGER PRIMARY KEY, tenant TEXT NOT NULL, id TEXT NOT NULL, kind INTEGER NOT NULL, pubkey TEXT NOT NULL, created_at INTEGER NOT NULL, json TEXT NOT NULL )",
            "CREATE UNIQUE INDEX rumors_id ON rumors (tenant, id)",
            "CREATE INDEX rumors_tenant ON rumors (tenant)",
            "CREATE INDEX rumors_kind ON rumors (tenant, kind)",
            "CREATE INDEX rumors_pubkey ON rumors (tenant, pubkey)",
            "CREATE INDEX rumors_pubkey_kind ON rumors (tenant, pubkey, kind)",
            "CREATE VIRTUAL TABLE rumor_tags_fts USING fts5( tokens, tokenize = 'ascii tokenchars '':_''', content = '', contentless_delete = 1, detail = none )",
            "CREATE TRIGGER rumors_tags_delete AFTER DELETE ON rumors BEGIN DELETE FROM rumor_tags_fts WHERE rowid = old.seq; END",
            "CREATE TABLE rumor_coords ( tenant TEXT NOT NULL, coord TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (tenant, coord) ) WITHOUT ROWID",
            "CREATE TABLE tenants ( ord INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE )",
            "CREATE TABLE kv ( key TEXT PRIMARY KEY, value TEXT NOT NULL ) WITHOUT ROWID",
            "CREATE VIRTUAL TABLE rumors_fts USING fts5( content, tokenize = 'unicode61 remove_diacritics 2', content = '', contentless_delete = 1 )",
            "CREATE TRIGGER rumors_fts_insert AFTER INSERT ON rumors BEGIN INSERT INTO rumors_fts (rowid, content) VALUES (new.seq, json_extract(new.json, '\$.content')); END",
            "CREATE TRIGGER rumors_fts_delete AFTER DELETE ON rumors BEGIN DELETE FROM rumors_fts WHERE rowid = old.seq; END",
        )
        for (statement in v0Schema) raw.run(statement)

        // Write the way the v0 engine did: a json row plus a token row.
        fun v0Write(tenant: String, r: Rumor) {
            raw.run("INSERT OR IGNORE INTO tenants (id) VALUES (?)", listOf(tenant))
            val ord = raw.query("SELECT ord FROM tenants WHERE id = ?", listOf(tenant)) { it.long(0) }.first()
            val seq = r.createdAt * (1L shl 20)

            raw.run(
                "INSERT INTO rumors (seq, tenant, id, kind, pubkey, created_at, json) VALUES (?, ?, ?, ?, ?, ?, ?)",
                listOf(seq, tenant, r.id, r.kind, r.pubkey, r.createdAt, r.toJson()),
            )

            val tokens = StringBuilder("t$ord:_p:${r.pubkey}")
            for (tag in r.tags) {
                if (tag.size >= 2) tokens.append(" t$ord:${tag[0]}:${tag[1]}")
            }
            raw.run("INSERT INTO rumor_tags_fts (rowid, tokens) VALUES (?, ?)", listOf(seq, tokens.toString()))
        }

        // Two tenants, so each row must follow its own tenant's ordinal.
        v0Write("main", rumor(id = "plain", createdAt = 100, tags = listOf(listOf("e", "aa")), content = "hello alpes"))
        v0Write("c2:abc", rumor(id = "other", pubkey = "bob", createdAt = 150, content = ""))

        // A replaceable, occupying a coordinate.
        v0Write("main", rumor(id = "prof1", createdAt = 200, kind = 0, content = ""))
        raw.run(
            "INSERT INTO rumor_coords (tenant, coord, id, seq, created_at) VALUES (?, ?, ?, ?, ?)",
            listOf("main", "0:alice:", "prof1", 200L * (1L shl 20), 200L),
        )
        raw.run("INSERT INTO kv (key, value) VALUES (?, ?)", listOf("k", "\"v\""))

        val recording = RecordingDriver(raw)
        driver = recording
        val db = SqliteArmadaDb(recording).also { store = it }

        // The layout moved...
        val columns = recording.query("SELECT name FROM pragma_table_info('rumors')") { it.text(0) }
        assertEquals(listOf("seq", "tenant", "id", "kind", "pubkey", "created_at", "tags", "content"), columns)
        assertEquals(1L, recording.query("PRAGMA user_version") { it.long(0) }.first())

        // ...and nothing else did: bodies, the tag index, the search index,
        // the coordinate and the KV all survive, with their old rowids.
        val plain = db.query("main", filters("{\"ids\":[\"plain\"]}"))
        assertEquals(listOf("plain"), plain.map { it.id })
        assertEquals("hello alpes", plain[0].content)
        assertEquals(listOf(listOf<String?>("e", "aa")), plain[0].tags)
        assertEquals(listOf("plain"), db.query("main", filters("{\"#e\":[\"aa\"]}")).map { it.id })
        assertEquals(listOf("other"), db.query("c2:abc", filters("{}")).map { it.id })
        assertEquals(listOf("plain"), db.query("main", filters("{\"search\":\"alpes\"}")).map { it.id })
        assertEquals("\"v\"", db.kvGet("k"))

        // The rebuilt coordinate still supersedes.
        db.event("main", rumor(id = "prof2", createdAt = 300, kind = 0))
        assertEquals(listOf("prof2"), db.query("main", filters("{\"kinds\":[0]}")).map { it.id })
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private fun rowCount(table: String): Long =
        driver!!.query("SELECT COUNT(*) FROM $table") { it.long(0) }.first()

    private fun filters(vararg json: String): List<JSONObject> = json.map { JSONObject(it) }

    private fun rumor(
        id: String,
        pubkey: String = "alice",
        createdAt: Long = 1000,
        kind: Int = 1,
        tags: List<List<String>> = emptyList(),
        content: String = "hello",
    ): Rumor = Rumor.of(id, pubkey, createdAt, kind, tags, content)!!

    /**
     * A driver that remembers the SELECTs a call issued, so a plan can be
     * asserted rather than inferred from timings — the whole point of forcing
     * indexes and of the `CROSS JOIN`.
     */
    private class RecordingDriver(private val inner: ArmadaSqlDriver) : ArmadaSqlDriver {
        val selects = mutableListOf<Pair<String, List<Any?>>>()

        override fun run(sql: String, params: List<Any?>) = inner.run(sql, params)

        override fun <T> query(sql: String, params: List<Any?>, read: (SqlRow) -> T): List<T> {
            if (sql.startsWith("SELECT")) selects.add(sql to params)
            return inner.query(sql, params, read)
        }

        override fun close() = inner.close()

        /** The `EXPLAIN QUERY PLAN` details of every SELECT [body] issued. */
        fun record(body: () -> Unit): List<String> {
            selects.clear()
            body()
            return selects.flatMap { (sql, params) ->
                inner.query("EXPLAIN QUERY PLAN $sql", params) { it.text(3) }
            }
        }

        /** The MATCH expression the last recorded scan bound, if any. */
        fun lastMatchExpression(): String? = selects
            .lastOrNull { it.first.contains("MATCH") }
            ?.second
            ?.firstOrNull() as? String
    }
}
