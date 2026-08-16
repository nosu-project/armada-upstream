package buzz.armada.app.db

/**
 * The one table of derived-term policies: which tenants derive index terms, and
 * what they derive. A port of `src/lib/db/termPolicies.ts`.
 *
 * [SqliteArmadaDb] never interprets a tenant id or a term — that is the whole
 * contract, and it is why nothing NIP-17-shaped is inside it. This object is
 * where the knowledge lives instead, and it is deliberately the ONLY place: a
 * policy spelled two ways files rows under a term nothing looks up, which is a
 * silent read of nothing, repairable only by dropping the index and walking the
 * tenant again.
 *
 * It has to agree with the TypeScript table exactly, not merely in spirit. The
 * WebView and the notification service write into the same file and the same
 * tenants, so a rumor the service files under a term the WebView does not look
 * up is a message that arrived while the app was dead and that the thread then
 * never shows. `Dm17Test` pins the derivation against the vectors the other side
 * produces.
 */
internal object TermPolicies {

    /**
     * Which revision of the policies below the index is built by — the same
     * number as `TERM_GENERATION` in `src/lib/db/termPolicies.ts` and
     * `TermPolicies.generation` in Swift.
     *
     * BUMP IT whenever [termsOf] changes what it derives. The index is built by
     * a one-time pass per tenant which records this number; a derivation that
     * changes without it is silent and permanent, since rows already on disk
     * keep the terms they were written with.
     *
     * All three ports write it into ONE file, so two that disagree would each
     * read the other's as stale and rebuild the index on every open, forever.
     * `ArmadaDbTest` pins the literal.
     *
     *   1  `conv:<peers>` — a rumor filed under its NIP-17 conversation.
     *   2  adds `convmsg:<peers>` (chat and file rumors only) and
     *      `convmine:<peers>` (the same, authored by the viewer), which is what
     *      makes the conversation list a collapse over an index rather than a
     *      sample of the newest rumors.
     */
    const val GENERATION = 2L

    /**
     * The derived terms of a rumor stored in [tenantId], or empty when that
     * tenant derives none — which is most of them, and means a term read
     * against one matches nothing.
     */
    fun termsOf(rumor: Rumor, tenantId: String): List<String> = when {
        // A NIP-17 conversation is a participant SET, which a NIP-01 filter can
        // only over-select. See [Dm17.peersOf].
        Dm17.tenantSelf(tenantId) != null -> Dm17.termsOf(rumor, tenantId)
        else -> emptyList()
    }
}
