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
        assertEquals(listOf("alice"), Dm17.peersOf(rumor(kind = 14, pubkey = "alice"), self))

        val mine = rumor(kind = 14, pubkey = self, tags = listOf(listOf("p", "bob")))
        assertEquals(listOf("bob"), Dm17.peersOf(mine, self))
        assertTrue(Dm17.storable(self, mine, now))
    }

    @Test
    fun `refuses our own copy with no recipient to attribute it to`() {
        assertNull(Dm17.peersOf(rumor(kind = 14, pubkey = self), self))
        assertFalse(Dm17.storable(self, rumor(kind = 14, pubkey = self), now))
    }

    @Test
    fun `a peer tag on the rumor cannot move it into another conversation`() {
        // Nothing is injected and nothing reads a `peer` tag, so spelling one
        // out is inert — the conversation comes from the author and `p` tags.
        val forged = rumor(kind = 14, pubkey = "mallory", tags = listOf(listOf("peer", "bob")))
        assertEquals(listOf("mallory"), Dm17.peersOf(forged, self))
    }

    @Test
    fun `names the tenant per viewer`() {
        assertEquals("dm17:$self", Dm17.tenant(self))
        assertEquals(self, Dm17.tenantSelf("dm17:$self"))
        assertNull(Dm17.tenantSelf("main"))
    }

    // ── Conversation identity ────────────────────────────────────────────────
    //
    // These must agree with `src/lib/nip17/conversation.ts` exactly. The term
    // this derivation produces is what a rumor is FILED under, and the WebView
    // looks it up by deriving it independently — so a divergence here is a
    // message received while the app was dead that the thread never shows.

    @Test
    fun `a group is the participant set, from either direction`() {
        // Received: the sender joins the room whether or not they p-tagged
        // themselves, and the viewer is never their own peer.
        val received = rumor(
            kind = 14,
            pubkey = "alice",
            tags = listOf(listOf("p", self), listOf("p", "bob")),
        )
        assertEquals(listOf("alice", "bob"), Dm17.peersOf(received, self))

        // Our own copy of the same room reduces to the same set, which is what
        // makes both halves of one conversation one conversation.
        val mine = rumor(
            kind = 14,
            pubkey = self,
            tags = listOf(listOf("p", "alice"), listOf("p", "bob")),
        )
        assertEquals(listOf("alice", "bob"), Dm17.peersOf(mine, self))
        assertEquals(Dm17.convTerm(listOf("alice", "bob")), Dm17.convTerm(listOf("bob", "alice")))
    }

    @Test
    fun `note to self is its own conversation`() {
        val note = rumor(kind = 14, pubkey = self, tags = listOf(listOf("p", self)))
        assertEquals(listOf(self), Dm17.peersOf(note, self))
        assertTrue(Dm17.storable(self, note, now))
    }

    @Test
    fun `a one-to-one term is the peer alone, unseparated`() {
        // Pubkeys are fixed-width hex, so a set is joined with nothing — a term
        // crosses a NIP-50 search string, whose parse ends a token at
        // whitespace.
        assertEquals("conv:alice", Dm17.convTerm(listOf("alice")))
        assertEquals("conv:alicebob", Dm17.convTerm(listOf("bob", "alice")))
    }

    @Test
    fun `a one-to-one conversation key is the peer alone`() {
        // The equivalence the notification path rests on: a 1:1 room key, its
        // read marker and its `/dm/<key>` deep link are byte-identical to the
        // single-pubkey spelling that predates group DMs, so making the service
        // conversation-keyed re-files no existing thread.
        assertEquals("alice", Dm17.convKey(listOf("alice")))
        assertEquals(listOf("alice"), Dm17.convPeers("alice"))
        // Note to Self is `[self]`, and so is a key like any other.
        assertEquals(self, Dm17.convKey(listOf(self)))
    }

    @Test
    fun `a group conversation key round-trips through its participants`() {
        // Sorted, so the two directions of one conversation name one key —
        // and separated, unlike a term, because a key is read back apart to
        // become the `p` tags of a reply.
        assertEquals("alice,bob", Dm17.convKey(listOf("bob", "alice")))
        assertEquals(listOf("alice", "bob"), Dm17.convPeers("alice,bob"))
        assertEquals(
            Dm17.convKey(listOf("alice", "bob")),
            Dm17.convKey(listOf("bob", "alice")),
        )
    }

    @Test
    fun `an empty conversation key names nobody`() {
        // What `canReply` leans on: a room key the service can't decode is one
        // it must not seal a reply for.
        assertEquals(emptyList<String>(), Dm17.convPeers(""))
        assertEquals(emptyList<String>(), Dm17.convPeers(","))
    }

    @Test
    fun `a rumor's conversation key is its participant set`() {
        // The derivation the notification path makes: keyed by the SENDER, a
        // group message would land in the 1:1 thread with whoever spoke.
        val received = rumor(
            kind = 14,
            pubkey = "alice",
            tags = listOf(listOf("p", self), listOf("p", "bob")),
        )
        assertEquals("alice,bob", Dm17.convKey(Dm17.peersOf(received, self)!!))
    }

    @Test
    fun `files a rumor under the conversation its tenant names`() {
        val received = rumor(
            kind = 14,
            pubkey = "alice",
            tags = listOf(listOf("p", self), listOf("p", "bob")),
        )
        // Every rumor of the conversation, plus the message-only namespace the
        // conversation list collapses over.
        assertEquals(
            listOf("conv:alicebob", "convmsg:alicebob"),
            TermPolicies.termsOf(received, Dm17.tenant(self)),
        )
        // A tenant that derives no terms says so, rather than guessing.
        assertEquals(emptyList<String>(), TermPolicies.termsOf(received, "main"))
    }

    @Test
    fun `files the viewer's own message under the mine namespace too`() {
        val sent = rumor(kind = 14, pubkey = self, tags = listOf(listOf("p", "alice")))
        // `convmine:` is what "conversations I have written in" is a collapse
        // over — the set that keeps a thread with someone the viewer doesn't
        // follow, and that tells the notification path they are not a stranger.
        assertEquals(
            listOf("conv:alice", "convmsg:alice", "convmine:alice"),
            TermPolicies.termsOf(sent, Dm17.tenant(self)),
        )
    }

    @Test
    fun `keeps a reaction out of the message namespaces`() {
        // A reaction belongs to the conversation but is not a row the list can
        // show, and `distinct:convmsg` is how it never becomes one.
        val reaction = rumor(kind = 7, pubkey = self, tags = listOf(listOf("p", "alice")))
        assertEquals(listOf("conv:alice"), TermPolicies.termsOf(reaction, Dm17.tenant(self)))
    }

    @Test
    fun `an unattributable rumor is filed under nothing`() {
        val orphan = rumor(kind = 14, pubkey = self)
        assertEquals(emptyList<String>(), TermPolicies.termsOf(orphan, Dm17.tenant(self)))
    }

    private fun rumor(
        kind: Int,
        pubkey: String,
        tags: List<List<String>> = emptyList(),
    ): Rumor = Rumor.of("id-$kind-$pubkey", pubkey, now - 10, kind, tags, "hello")!!
}
