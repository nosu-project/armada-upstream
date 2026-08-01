package buzz.armada.app.db

/**
 * The NIP-17 opened-DM store's rules, in Kotlin — a port of the parts of
 * `src/lib/nip17/dm17Store.ts` and `protocol.ts` that decide what may be stored
 * and how it is shaped.
 *
 * The background service decrypts DM gift wraps for its notifications anyway, so
 * it files the recovered rumor in the same per-viewer tenant the WebView reads
 * (`dm17:<self>`) rather than throwing it away and leaving the app to open the
 * wrap a second time. That only works if it obeys the same rules — otherwise the
 * two writers disagree about what a conversation contains.
 *
 * Pure and Context-free so the rules can be tested on the JVM without an
 * emulator; [ServiceStore.storeDm17Rumor] is the thin part that writes.
 */
internal object Dm17 {

    /**
     * The rumor kinds the DM store holds: NIP-09 delete, NIP-25 reaction,
     * chat, file, and Armada's disappearing-messages timer.
     *
     * Typing indicators (23311) are deliberately absent — the signal IS the
     * event's existence, it lives for seconds, and it must never reach the store.
     */
    val KINDS = setOf(5, 7, 14, 15, 1740)

    /** The ArmadaDB tenant holding one viewer's opened DMs. */
    fun tenant(self: String): String = "dm17:$self"

    /**
     * The NIP-40 deadline these tags carry, or null. `Number(raw)` semantics:
     * anything that isn't a finite number is no deadline at all.
     */
    fun expirationOf(tags: List<List<String?>>): Long? {
        val raw = tags.firstOrNull { it.getOrNull(0) == "expiration" }?.getOrNull(1) ?: return null
        val secs = raw.trim().toDoubleOrNull() ?: return null
        if (secs.isNaN() || secs.isInfinite()) return null
        return secs.toLong()
    }

    /** Whether these tags carry a NIP-40 deadline that has already passed. */
    fun isExpired(tags: List<List<String?>>, now: Long): Boolean {
        val at = expirationOf(tags) ?: return false
        return at <= now
    }

    /**
     * The conversation partner of a rumor, from `self`'s perspective: the sender
     * for received rumors, the first `p` tag for our own copies. Null when
     * unattributable (an own copy with no `p` tag).
     */
    fun peerOf(rumor: Rumor, self: String): String? {
        if (rumor.pubkey != self) return rumor.pubkey
        return rumor.tags.firstOrNull { it.getOrNull(0) == "p" && !it.getOrNull(1).isNullOrEmpty() }
            ?.get(1)
    }

    /**
     * Whether an opened DM rumor may be stored.
     *
     * What IS stored is the rumor, untouched — nothing is injected on the way
     * in. A rumor's tags are the bytes its id commits to, so bookkeeping
     * written into them makes the stored row something its sender never signed,
     * and makes the store's own idea of a conversation forgeable by anyone who
     * spells that tag themselves. The partner is derived on read instead, from
     * the author and `p` tags ([peerOf]).
     *
     * Refused when:
     *
     *  - it isn't a DM-plane kind (a typing signal, or a foreign rumor kind
     *    that arrived in a DM wrap — Concord invites travel this way);
     *  - its NIP-40 deadline has passed. This is the single choke point every
     *    writer goes through, which is why the check lives here and not only at
     *    the point of decryption: a disappearing message that arrives late is
     *    simply never stored;
     *  - it has no attributable conversation partner, so no read could ever
     *    surface it in a thread.
     */
    fun storable(self: String, rumor: Rumor, now: Long): Boolean {
        if (self.isEmpty()) return false
        if (rumor.kind !in KINDS) return false
        if (isExpired(rumor.tags, now)) return false
        return peerOf(rumor, self) != null
    }
}
