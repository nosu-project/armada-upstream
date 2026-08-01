package buzz.armada.app.db

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The tenant-routing rule, ported from `src/lib/db/relayScope.ts` alongside the
 * code — the same cases in the same order as `relayScope.test.ts`.
 *
 * This is the rule that makes a second writer safe. The WebView and the service
 * both file relay events into ArmadaDB, so a rule only one of them applies is a
 * disagreement about where a message LIVES: a NIP-29 message the service received
 * while the app was dead would land in a tenant the timeline never reads, and be
 * invisible on open — precisely the bug the shared native store was built to end.
 */
class RelayScopeTest {

    private val relay = "wss://relay.example"

    // ── isRelayScoped ────────────────────────────────────────────────────────

    @Test
    fun `scopes anything carrying an h tag`() {
        // Not a kind list: `h` is NIP-29's own statement that the event means
        // something only inside one group on one relay, so a group-scoped kind
        // added later is handled without touching the rule.
        for (kind in listOf(9, 11, 1111, 7, 1068, 9450, 9000, 9021, 31923, 5)) {
            assertTrue("kind $kind", RelayScope.isRelayScoped(rumor(kind, listOf(listOf("h", "abc")))))
        }
    }

    @Test
    fun `scopes relay-signed group state, which carries no h tag`() {
        for (kind in listOf(39000, 39001, 39002, 39003, 39004, 39005, 13534)) {
            assertTrue("kind $kind", RelayScope.isRelayScoped(rumor(kind, listOf(listOf("d", "abc")))))
        }
    }

    @Test
    fun `leaves global data alone, even kinds that double as group-scoped`() {
        // A kind-5 delete, a reaction or a NIP-22 comment outside a group is an
        // ordinary global event. Relay-scoping these would fork one identity into
        // a copy per relay and hide a profile learned on one relay from the rest.
        assertFalse(RelayScope.isRelayScoped(rumor(0)))
        assertFalse(RelayScope.isRelayScoped(rumor(5, listOf(listOf("e", "x")))))
        assertFalse(RelayScope.isRelayScoped(rumor(7, listOf(listOf("e", "x")))))
        assertFalse(RelayScope.isRelayScoped(rumor(1111, listOf(listOf("E", "x")))))
        assertFalse(RelayScope.isRelayScoped(rumor(10009)))
        assertFalse(RelayScope.isRelayScoped(rumor(1985, listOf(listOf("r", relay)))))
        assertFalse(RelayScope.isRelayScoped(rumor(1059)))
        assertFalse(RelayScope.isRelayScoped(rumor(3300)))
    }

    @Test
    fun `ignores a malformed or empty h tag`() {
        assertFalse(RelayScope.isRelayScoped(rumor(9, listOf(listOf("h")))))
        assertFalse(RelayScope.isRelayScoped(rumor(9, listOf(listOf("h", "")))))
    }

    // ── Tenant ids ───────────────────────────────────────────────────────────

    @Test
    fun `spells the tenant exactly as the WebView does`() {
        assertEquals("nip29:$relay", ArmadaDb.nip29Tenant(relay))
    }

    @Test
    fun `trims a trailing slash, so a URL that skipped the JS normalizer agrees`() {
        assertEquals(ArmadaDb.nip29Tenant(relay), ArmadaDb.nip29Tenant("$relay/"))
    }

    @Test
    fun `keeps a path, so two deployments on one host stay apart`() {
        assertFalse(ArmadaDb.nip29Tenant("wss://a.example/eu") == ArmadaDb.nip29Tenant("wss://a.example"))
    }

    // ── tenantFor ────────────────────────────────────────────────────────────

    @Test
    fun `sends global data to main, relay or no relay`() {
        assertEquals(ArmadaDb.TENANT_MAIN, RelayScope.tenantFor(rumor(0), null))
        assertEquals(ArmadaDb.TENANT_MAIN, RelayScope.tenantFor(rumor(0), relay))
    }

    @Test
    fun `sends relay-relative data to that relay's tenant`() {
        assertEquals(
            ArmadaDb.nip29Tenant(relay),
            RelayScope.tenantFor(rumor(9, listOf(listOf("h", "abc"))), relay),
        )
        assertEquals(
            ArmadaDb.nip29Tenant(relay),
            RelayScope.tenantFor(rumor(39000, listOf(listOf("d", "abc"))), relay),
        )
    }

    @Test
    fun `stores NOTHING relay-relative when the relay is unknown`() {
        // The service always knows its relay (one socket per relay), so this is a
        // guard rather than a path — but dropping is still right: the alternative
        // is filing a group's messages under a guess and merging two servers'
        // channels, which is the bug the split exists to prevent.
        assertNull(RelayScope.tenantFor(rumor(9, listOf(listOf("h", "abc"))), null))
        assertNull(RelayScope.tenantFor(rumor(39000, listOf(listOf("d", "abc"))), null))
        assertNull(RelayScope.tenantFor(rumor(9, listOf(listOf("h", "abc"))), ""))
    }

    // ── Queue tenants ────────────────────────────────────────────────────────

    @Test
    fun `queues per relay, and round-trips the relay through the tenant id`() {
        // The queue tenant's id is the only unforgeable place a drained page's
        // source relay can live: a rumor carries no record of it, and a `relay`
        // tag injected into one would be spellable by any sender.
        val tenant = ArmadaDb.serviceQueueTenant(relay)
        assertEquals("svc:$relay", tenant)
        assertEquals(relay, ArmadaDb.queueTenantRelay(tenant))
    }

    @Test
    fun `falls back to the retired unscoped queue when there is no relay`() {
        assertEquals(ArmadaDb.TENANT_SERVICE_QUEUE, ArmadaDb.serviceQueueTenant(null))
        assertEquals(ArmadaDb.TENANT_SERVICE_QUEUE, ArmadaDb.serviceQueueTenant(""))
        assertNull(ArmadaDb.queueTenantRelay(ArmadaDb.TENANT_SERVICE_QUEUE))
    }

    private fun rumor(kind: Int, tags: List<List<String>> = emptyList()): Rumor =
        Rumor.of("id-$kind", "pubkey", 1_000L, kind, tags, "hello")!!
}
