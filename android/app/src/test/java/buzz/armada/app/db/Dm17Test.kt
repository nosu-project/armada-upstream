package buzz.armada.app.db

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
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
    fun `stores a chat rumor from a peer`() {
        assertTrue(Dm17.storable(self, rumor(kind = 14, pubkey = "alice"), now))
    }

    @Test
    fun `keeps every DM-plane kind`() {
        for (kind in listOf(5, 7, 14, 15, 1740)) {
            assertTrue(Dm17.storable(self, rumor(kind = kind, pubkey = "alice"), now))
        }
    }

    @Test
    fun `refuses a typing signal and other foreign kinds`() {
        // A typing indicator exists for seconds and must never be stored; a
        // Concord invite arrives in a DM wrap but belongs to another plane.
        assertFalse(Dm17.storable(self, rumor(kind = 23311, pubkey = "alice"), now))
        assertFalse(Dm17.storable(self, rumor(kind = 1059, pubkey = "alice"), now))
    }

    @Test
    fun `refuses a rumor whose deadline has passed`() {
        val expired = rumor(kind = 14, pubkey = "alice", tags = listOf(listOf("expiration", "${now - 1}")))
        assertFalse(Dm17.storable(self, expired, now))

        val live = rumor(kind = 14, pubkey = "alice", tags = listOf(listOf("expiration", "${now + 1}")))
        assertTrue(Dm17.storable(self, live, now))
    }

    @Test
    fun `treats the deadline as reached at the deadline`() {
        val due = rumor(kind = 14, pubkey = "alice", tags = listOf(listOf("expiration", "$now")))
        assertFalse(Dm17.storable(self, due, now))
    }

    @Test
    fun `ignores an unparseable expiration rather than dropping the rumor`() {
        val nonsense = rumor(kind = 14, pubkey = "alice", tags = listOf(listOf("expiration", "soon")))
        assertTrue(Dm17.storable(self, nonsense, now))
    }

    @Test
    fun `attributes a received rumor to its author and our own copy to its recipient`() {
        assertEquals("alice", Dm17.peerOf(rumor(kind = 14, pubkey = "alice"), self))

        val mine = rumor(kind = 14, pubkey = self, tags = listOf(listOf("p", "bob")))
        assertEquals("bob", Dm17.peerOf(mine, self))
        assertTrue(Dm17.storable(self, mine, now))
    }

    @Test
    fun `refuses our own copy with no recipient to attribute it to`() {
        assertNull(Dm17.peerOf(rumor(kind = 14, pubkey = self), self))
        assertFalse(Dm17.storable(self, rumor(kind = 14, pubkey = self), now))
    }

    @Test
    fun `a peer tag on the rumor cannot move it into another conversation`() {
        // Nothing is injected and nothing reads a `peer` tag, so spelling one
        // out is inert — the partner comes from the author.
        val forged = rumor(kind = 14, pubkey = "mallory", tags = listOf(listOf("peer", "bob")))
        assertEquals("mallory", Dm17.peerOf(forged, self))
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
