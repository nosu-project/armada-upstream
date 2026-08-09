package buzz.armada.app.db

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The catalogue the service subscribes to on the user's behalf, ported from
 * `src/lib/selfSyncKinds.ts` alongside the code.
 *
 * Two things are load-bearing here. The kind/`d` set has to match the WebView's
 * or the two writers disagree about what "the user's state" even is. And the
 * authorship refusal is what stops a relay answering our filter with somebody
 * else's document from writing into the store the rail is rendered from.
 */
class SelfStateTest {

    private val self = "self-pubkey"

    @Test
    fun `keeps every bare replaceable kind in the catalogue`() {
        // Follow, mute, NIP-29 servers/channels, DM relays, Blossom, emoji,
        // and the Concord community + invite lists.
        for (kind in listOf(3, 10000, 10009, 10050, 10063, 10030, 13302, 13303)) {
            assertTrue("kind $kind", SelfState.storable(self, rumor(kind = kind)))
        }
    }

    @Test
    fun `matches the WebView's catalogue exactly`() {
        // Drift here is silent: the service would stop mirroring a list the app
        // still syncs, and only ever show up as "that one setting doesn't
        // travel between my devices".
        assertEquals(setOf(3, 10000, 10009, 10050, 10063, 10030, 13302, 13303), SelfState.KINDS)
        assertEquals(
            setOf(
                "armada/metadata",
                "armada/rail",
                "armada/read-state",
                "armada/notifications",
                "armada/dms",
                "armada/reactions",
            ),
            SelfState.DEFAULT_D_TAGS,
        )
    }

    @Test
    fun `keeps every one of Armada's own NIP-78 documents`() {
        // Six documents, not one: the rail's arrangement, the read state and
        // the mutes each have their own, and a service that mirrored only
        // `metadata` would leave five of them to arrive on next app open.
        for (dTag in SelfState.DEFAULT_D_TAGS) {
            assertTrue(dTag, SelfState.storable(self, rumor(kind = 30078, tags = listOf(listOf("d", dTag)))))
        }
    }

    @Test
    fun `uses the configured tag set when the WebView supplies one`() {
        // A fork changes VITE_APP_ID and every document is renamed with it.
        val forked = setOf("fork/metadata", "fork/rail")
        assertTrue(
            SelfState.storable(self, rumor(kind = 30078, tags = listOf(listOf("d", "fork/rail"))), forked),
        )
        // …and the default build's tags are then somebody else's documents.
        assertFalse(
            SelfState.storable(
                self,
                rumor(kind = 30078, tags = listOf(listOf("d", "armada/rail"))),
                forked,
            ),
        )
    }

    @Test
    fun `keeps the GIF-favorite shards, which are named by topic not by d`() {
        val shard = rumor(
            kind = 30078,
            tags = listOf(listOf("d", "armada-gif-favorites-abc123"), listOf("t", "armada-gif-favorites")),
        )
        assertTrue(SelfState.storable(self, shard))
    }

    @Test
    fun `refuses another client's NIP-78 document`() {
        // Kind 30078 is shared with every other app on this identity; storing
        // the lot would be someone else's data at our expense.
        assertFalse(SelfState.storable(self, rumor(kind = 30078, tags = listOf(listOf("d", "snort/settings")))))
        assertFalse(SelfState.storable(self, rumor(kind = 30078)))
    }

    @Test
    fun `refuses a document authored by anyone else`() {
        // The whole point of the read is "what did I say my state was", so a
        // relay handing back a stranger's 10009 must not land in `main` and
        // become the rail.
        assertFalse(SelfState.storable(self, rumor(kind = 10009, pubkey = "mallory")))
        assertFalse(
            SelfState.storable(
                self,
                rumor(kind = 30078, pubkey = "mallory", tags = listOf(listOf("d", "armada/metadata"))),
            ),
        )
    }

    @Test
    fun `refuses everything outside the catalogue`() {
        // Chat, gift wraps and NIP-29 group state each have their own writer
        // and their own tenant; none of them arrives through this filter.
        for (kind in listOf(1, 9, 14, 1059, 3300, 39000)) {
            assertFalse("kind $kind", SelfState.storable(self, rumor(kind = kind)))
        }
    }

    @Test
    fun `refuses everything when there is no logged-in user`() {
        // No identity means no "own" state to recognise, so nothing qualifies —
        // rather than the author check degenerating into "matches empty".
        assertFalse(SelfState.storable("", rumor(kind = 10009, pubkey = "alice")))
    }

    @Test
    fun `pre-filter admits exactly the catalogue's kinds`() {
        for (kind in listOf(3, 10000, 10009, 10050, 10063, 10030, 13302, 13303, 30078)) {
            assertTrue("kind $kind", SelfState.isSelfKind(kind))
        }
        for (kind in listOf(0, 1, 9, 1059, 10002, 39000)) {
            assertFalse("kind $kind", SelfState.isSelfKind(kind))
        }
    }

    private fun rumor(
        kind: Int,
        pubkey: String = self,
        tags: List<List<String>> = emptyList(),
    ): Rumor = Rumor.of("id-$kind-$pubkey", pubkey, 1_000_000L, kind, tags, "")!!
}
