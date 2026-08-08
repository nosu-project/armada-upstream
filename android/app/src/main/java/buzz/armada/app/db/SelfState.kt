package buzz.armada.app.db

/**
 * The logged-in user's OWN replaceable/addressable documents — a Kotlin port of
 * the catalogue in `src/lib/selfSyncKinds.ts`.
 *
 * These are the events that describe who you are and what you've joined: follow
 * and mute lists, the NIP-29 server/channel list, the Concord membership
 * vault, DM/Blossom/emoji relay lists, and Armada's own NIP-78 settings
 * document (which carries the community rail's arrangement).
 *
 * The WebView keeps them fresh with a standing REQ while it is alive. It isn't,
 * most of the time — so a change made on another device landed nowhere until
 * the app was next opened AND a relay read happened to succeed at exactly the
 * moment the sockets were coldest. The service is awake and already connected,
 * so it subscribes to the same catalogue and files each version in the same
 * `main` tenant the WebView reads. Opening the app then finds the current list
 * already on disk, with no relay round-trip in the critical path.
 *
 * Nothing here decrypts. A 10009's private items and the 30078 settings blob
 * are NIP-44-encrypted to the user, and the service has no reason to open them:
 * storing the raw event verbatim is the whole job, and the WebView decrypts on
 * read exactly as it does for an event it fetched itself.
 *
 * Pure and Context-free so the rules can be tested on the JVM without an
 * emulator, matching [Dm17] and [Concord].
 */
object SelfState {

    /** NIP-78 application-specific data — Armada's settings document. */
    const val KIND_APP_SPECIFIC = 30078

    /**
     * The bare replaceable kinds, synced with a plain `{authors:[me], kinds:[…]}`
     * filter: follow (3), mute (10000), NIP-29 servers/channels (10009), DM
     * relays (10050), Blossom servers (10063), custom emoji (10030), and the
     * Concord community (13302) and invite (13303) lists.
     */
    @JvmField
    val KINDS: Set<Int> = setOf(3, 10000, 10009, 10050, 10063, 10030, 13302, 13303)

    /**
     * The `d` values of the addressable kind-30078 documents Armada owns. The
     * kind is shared with every other NIP-78 client on the user's identity, so
     * it is filtered by `d` rather than stored wholesale — a third-party app's
     * blob is none of our business and would only cost space.
     */
    @JvmField
    val D_TAGS: Set<String> = setOf("armada/metadata")

    /** Tag shared by the per-installation encrypted GIF-favorite shards. */
    const val TOPIC_GIF_FAVORITES = "armada-gif-favorites"

    /** Whether this kind could be part of the catalogue (a cheap pre-filter). */
    @JvmStatic
    fun isSelfKind(kind: Int): Boolean = kind in KINDS || kind == KIND_APP_SPECIFIC

    /**
     * Whether a received event is one of [self]'s own self-state documents and
     * may be stored.
     *
     * The authorship check is the security boundary, not a tidiness one. These
     * documents are read back as the user's truth — which servers they joined,
     * how their rail is arranged, who they mute — so a relay that answered our
     * filter with somebody else's event, or with an unsigned one, must not be
     * able to write into that. The caller verifies the signature; this refuses
     * anything not authored by [self].
     */
    @JvmStatic
    fun storable(self: String, rumor: Rumor): Boolean {
        if (self.isEmpty()) return false
        if (rumor.pubkey != self) return false
        if (rumor.kind in KINDS) return true
        if (rumor.kind != KIND_APP_SPECIFIC) return false
        // Addressable: keep only Armada's own documents.
        if (rumor.tagValue("d") in D_TAGS) return true
        return rumor.tagValue("t") == TOPIC_GIF_FAVORITES
    }
}
