package buzz.armada.app.db

/**
 * Which tenant an incoming relay event belongs in — [ArmadaDb.TENANT_MAIN], or a
 * tenant of its own for the relay that served it.
 *
 * THE KOTLIN HALF OF `src/lib/db/relayScope.ts`, and it must stay in step with
 * it. The service and the WebView are two writers into one database; a rule only
 * one of them applies is a disagreement about where a message lives, and here
 * that would mean a message received while the app was dead landing somewhere
 * the timeline never reads. The TS file carries the full rationale; the short
 * version:
 *
 * A NIP-29 group is named by an `h`/`d` tag value like `abc123`, which means
 * nothing on its own — the same id on two relays is two unrelated groups, so the
 * group's real identity is the PAIR (relay, id). Scoping by the signing key
 * instead doesn't work either: some relay software (zooid) ships a SHARED relay
 * identity, so two servers advertise the same NIP-11 `self`, and since kind 39000
 * is addressable that makes two servers' metadata REPLACE one another rather than
 * merely mix. The only discriminator is where the event was served from, which is
 * not in the event — so it goes in the tenant id.
 *
 * Relay-relative, therefore relay-scoped:
 *
 *  - anything carrying an `h` tag (NIP-29's group marker): chat, polls, threads,
 *    comments, reactions, the 9000-9022 moderation range, group-scoped calendar
 *    entries, and the kind-5 deletes moderators issue inside a group. Derived
 *    from the event rather than listed as kinds, so a group-scoped kind added
 *    later is scoped right without touching this file.
 *  - relay-signed relay/group state ([RELAY_STATE_KINDS]), which carries no `h`
 *    and is exactly what the shared-identity problem breaks.
 *
 * Everything else stays in `main`: profiles, the user's own lists, git activity,
 * ciphertext addressed to them. Those are facts about a pubkey, true whoever
 * served them, and relay-scoping them would fork one identity into N copies.
 */
object RelayScope {

    /**
     * Relay-signed state whose scope is the relay itself rather than an `h` tag:
     * 39000 metadata, 39001 admins, 39002 members, 39003 roles, 39004 live
     * participants, 39005 pins, and 13534's relay-wide NIP-43 roster.
     */
    private val RELAY_STATE = setOf(13534, 39000, 39001, 39002, 39003, 39004, 39005)

    /** The kinds [isRelayScoped] treats as relay-signed state. */
    @JvmStatic
    val RELAY_STATE_KINDS: Set<Int> get() = RELAY_STATE

    /**
     * Whether this event's identity depends on the relay that served it, and so
     * belongs in that relay's tenant rather than in `main`.
     */
    @JvmStatic
    fun isRelayScoped(rumor: Rumor): Boolean {
        if (rumor.kind in RELAY_STATE) return true
        return rumor.tags.any { it.size >= 2 && it[0] == "h" && !it[1].isNullOrEmpty() }
    }

    /**
     * The tenant [rumor] belongs in, or null to not store it at all.
     *
     * Null happens only for relay-relative data with no relay to file it under.
     * The service always knows its relay (it holds one socket per relay), so this
     * is a guard rather than a path — and dropping is still the right answer,
     * because the alternative is filing a group's messages under a guess and
     * merging two servers' channels, which is the bug this exists to prevent.
     */
    @JvmStatic
    fun tenantFor(rumor: Rumor, relayUrl: String?): String? {
        if (!isRelayScoped(rumor)) return ArmadaDb.TENANT_MAIN
        return if (relayUrl.isNullOrEmpty()) null else ArmadaDb.nip29Tenant(relayUrl)
    }
}
