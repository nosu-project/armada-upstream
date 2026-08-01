package buzz.armada.app.db

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The NIP-17 store rules the background service writes through, ported from
 * `dm17Store.ts` / `protocol.ts` alongside the code.
 *
 * These are the rules that make a second writer safe. The WebView and the
 * service both file rumors into `dm17:<self>`, so a rule only one of them
 * applies is a conversation the two disagree about — and two of them
 * (expiration, provenance) are the difference between a disappearing message
 * disappearing and a forged tag filing a message in someone else's thread.
 */
class Dm17Test {

    private val self = "self-pubkey"
    private val now = 1_000_000L

    @Test
    fun `stores a chat rumor under its sender`() {
        val stored = Dm17.stored(self, rumor(kind = 14, pubkey = "alice"), now)!!

        assertEquals("alice", stored.tagValue("peer"))
        assertEquals(14, stored.kind)
        assertEquals("hello", stored.content)
    }

    @Test
    fun `keeps every DM-plane kind`() {
        for (kind in listOf(5, 7, 14, 15, 1740)) {
            assertEquals(kind, Dm17.stored(self, rumor(kind = kind, pubkey = "alice"), now)?.kind)
        }
    }

    @Test
    fun `refuses a typing signal and other foreign kinds`() {
        // A typing indicator exists for seconds and must never be stored; a
        // Concord invite arrives in a DM wrap but belongs to another plane.
        assertNull(Dm17.stored(self, rumor(kind = 23311, pubkey = "alice"), now))
        assertNull(Dm17.stored(self, rumor(kind = 1059, pubkey = "alice"), now))
    }

    @Test
    fun `refuses a rumor whose deadline has passed`() {
        val expired = rumor(kind = 14, pubkey = "alice", tags = listOf(listOf("expiration", "${now - 1}")))
        assertNull(Dm17.stored(self, expired, now))

        val live = rumor(kind = 14, pubkey = "alice", tags = listOf(listOf("expiration", "${now + 1}")))
        assertEquals("alice", Dm17.stored(self, live, now)?.tagValue("peer"))
    }

    @Test
    fun `treats the deadline as reached at the deadline`() {
        val due = rumor(kind = 14, pubkey = "alice", tags = listOf(listOf("expiration", "$now")))
        assertNull(Dm17.stored(self, due, now))
    }

    @Test
    fun `ignores an unparseable expiration rather than dropping the rumor`() {
        val nonsense = rumor(kind = 14, pubkey = "alice", tags = listOf(listOf("expiration", "soon")))
        assertEquals("alice", Dm17.stored(self, nonsense, now)?.tagValue("peer"))
    }

    @Test
    fun `attributes our own copy to its recipient`() {
        val mine = rumor(kind = 14, pubkey = self, tags = listOf(listOf("p", "bob")))
        assertEquals("bob", Dm17.stored(self, mine, now)?.tagValue("peer"))
    }

    @Test
    fun `refuses our own copy with no recipient to attribute it to`() {
        assertNull(Dm17.stored(self, rumor(kind = 14, pubkey = self), now))
    }

    @Test
    fun `refuses a rumor that forges the store's own provenance`() {
        // The rumor's tags are written first, so a forged `peer` would win the
        // read-back and file this message in mallory's conversation with
        // someone else.
        val forged = rumor(kind = 14, pubkey = "mallory", tags = listOf(listOf("peer", "bob")))
        assertNull(Dm17.stored(self, forged, now))
        assertNull(Dm17.stored(self, rumor(kind = 14, pubkey = "mallory", tags = listOf(listOf("wrap", "x"))), now))
    }

    @Test
    fun `leaves the rumor's own tags byte-identical`() {
        val tags = listOf(listOf("p", "alice"), listOf("e", "abc"))
        val stored = Dm17.stored(self, rumor(kind = 14, pubkey = "alice", tags = tags), now)!!

        // Appended, never rewritten: the rumor id commits to these bytes.
        assertEquals(listOf("p", "alice"), stored.tags[0])
        assertEquals(listOf("e", "abc"), stored.tags[1])
        assertEquals(listOf("peer", "alice"), stored.tags[2])
    }

    @Test
    fun `names the tenant per viewer`() {
        assertEquals("dm17:$self", Dm17.tenant(self))
    }

    private fun rumor(
        kind: Int,
        pubkey: String,
        tags: List<List<String>> = emptyList(),
    ): Rumor = Rumor.of("id-$kind-$pubkey", pubkey, now - 10, kind, tags, "hello")!!
}
